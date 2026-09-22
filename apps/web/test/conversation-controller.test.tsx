// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ChatTransport, ConversationStore, type LiveSubscriptionHandlers } from "@turnturn/chat-client";
import {
  type ConversationId,
  DurableRecordTypes as Durable,
  type DurableRecord,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatTurnId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useConversationController } from "../src/features/conversation/useConversationController";

afterEach(cleanup);

const firstId = formatConversationId("11111111-1111-4111-8111-111111111111");
const secondId = formatConversationId("22222222-2222-4222-8222-222222222222");
const firstSessionId = formatSessionId("33333333-3333-4333-8333-333333333333");
const secondSessionId = formatSessionId("44444444-4444-4444-8444-444444444444");

test("a late response from the old selection cannot start its live subscription", async () => {
  let resolveFirst: ((value: unknown) => void) | undefined;
  const firstDetail = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const stopped: ConversationId[] = [];
  const subscribeEvents = vi.fn((id: ConversationId, handlers: LiveSubscriptionHandlers) => {
    queueMicrotask(() =>
      handlers.onSnapshot({
        conversationId: id,
        serverInstanceId: "server",
        sessions: [],
      }),
    );
    return () => stopped.push(id);
  });
  const getConversation = vi.fn((id: ConversationId) =>
    id === firstId
      ? firstDetail
      : Promise.resolve({
          sessions: [{ sessionId: secondSessionId, ordinal: 0, provider: "test", model: "test" }],
        }),
  );
  const transport = { getConversation, subscribeEvents } as unknown as ChatTransport;
  const firstStore = new ConversationStore(firstId);
  const secondStore = new ConversationStore(secondId);
  const models = [{ id: "test", label: "Test", provider: "test", model: "test" }];
  const onActivity = vi.fn(async () => {});

  function Selected({ id }: { readonly id: ConversationId }) {
    const controller = useConversationController({
      conversationId: id,
      store: id === firstId ? firstStore : secondStore,
      transport,
      models,
      defaultModelProfileId: "test",
      onActivity,
    });
    return <output>{`${id}:${controller.loading ? "loading" : controller.snapshot.connection.status}`}</output>;
  }

  const view = render(<Selected id={firstId} />);
  await waitFor(() => expect(getConversation).toHaveBeenCalledWith(firstId));
  view.rerender(<Selected id={secondId} />);
  await screen.findByText(`${secondId}:connected`);

  resolveFirst?.({ sessions: [{ sessionId: firstSessionId, ordinal: 0, provider: "test", model: "test" }] });
  await waitFor(() => expect(subscribeEvents).toHaveBeenCalledTimes(1));
  expect(subscribeEvents).toHaveBeenCalledWith(secondId, expect.anything());
  expect(stopped).toEqual([]);
  view.unmount();
  expect(stopped).toEqual([secondId]);
});

test("an accepted send stays accepted when the sidebar refresh fails", async () => {
  const transport = {
    getConversation: vi.fn(async () => ({ sessions: [] })),
    subscribeEvents: vi.fn((_id: ConversationId, handlers: LiveSubscriptionHandlers) => {
      queueMicrotask(() => handlers.onSnapshot({ conversationId: firstId, serverInstanceId: "server", sessions: [] }));
      return () => {};
    }),
    activateConversation: vi.fn(async () => ({
      sessionId: firstSessionId,
      ordinal: 0,
      provider: "test",
      model: "test",
    })),
    submitCommand: vi.fn(async () => ({ kind: "accepted" as const })),
  } as unknown as ChatTransport;

  function Selected() {
    const controller = useConversationController({
      conversationId: firstId,
      store: store,
      transport,
      models: [],
      defaultModelProfileId: "test",
      onActivity: async () => {
        throw new Error("Sidebar refresh failed");
      },
    });
    const [accepted, setAccepted] = useState<boolean | undefined>();
    return (
      <>
        <button
          type="button"
          disabled={controller.blocked}
          onClick={() => void controller.submit("Hello").then(setAccepted)}
        >
          Send
        </button>
        <output>{accepted === undefined ? "waiting" : accepted ? "accepted" : "rejected"}</output>
      </>
    );
  }

  const store = new ConversationStore(firstId);
  render(<Selected />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("accepted");
  expect(transport.submitCommand).toHaveBeenCalledTimes(1);
});

test("a rejected stale Stop refreshes but never claims the turn stopped", async () => {
  const turnId = formatTurnId("55555555-5555-4555-8555-555555555555");
  const record = (sequence: number, type: Durable, payload: object, scope: object = {}) =>
    ({
      schemaVersion: SCHEMA_VERSION,
      recordId: formatRecordId(`66666666-6666-4666-8666-${String(sequence).padStart(12, "0")}`),
      sequence,
      type,
      createdAt: "2026-09-22T00:00:00Z",
      conversationId: firstId,
      sessionId: firstSessionId,
      ...scope,
      payload,
    }) as DurableRecord;
  const records = [
    record(1, Durable.ConversationCreated, {}),
    record(2, Durable.SessionCreated, {}),
    record(3, Durable.TurnStarted, { input: "Investigate" }, { turnId }),
    record(4, Durable.UserInputAccepted, { text: "Investigate" }, { turnId }),
  ];
  expect(reduceEngineState(records).issues).toEqual([]);
  const store = new ConversationStore(firstId);
  store.registerSession(firstSessionId, 0);
  for (const item of records) store.ingestRecord(firstSessionId, item);
  const transport = {
    getConversation: vi.fn(async () => ({
      sessions: [{ sessionId: firstSessionId, ordinal: 0, provider: "test", model: "test" }],
    })),
    subscribeEvents: vi.fn((_id: ConversationId, handlers: LiveSubscriptionHandlers) => {
      queueMicrotask(() => handlers.onSnapshot({ conversationId: firstId, serverInstanceId: "server", sessions: [] }));
      return () => {};
    }),
    getRecords: vi.fn(async () => ({ sessionId: firstSessionId, records: [], lastSequence: 4, hasMore: false })),
    submitCommand: vi.fn(async () => ({
      kind: "rejected" as const,
      code: "TURN_NOT_RUNNING",
      message: "Turn is not running",
    })),
  } as unknown as ChatTransport;

  function Selected() {
    const controller = useConversationController({
      conversationId: firstId,
      store,
      transport,
      models: [],
      defaultModelProfileId: "test",
      onActivity: async () => {},
    });
    return (
      <>
        {controller.canStop ? (
          <button type="button" onClick={() => void controller.cancelActiveTurn()}>
            {controller.cancelPendingTurnId ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {controller.error ? <output>{controller.error}</output> : null}
      </>
    );
  }

  render(<Selected />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await screen.findByText("TURN_NOT_RUNNING: Turn is not running");
  expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
  expect(transport.getRecords).toHaveBeenCalledTimes(1);
  expect(transport.submitCommand).toHaveBeenCalledTimes(1);
});
