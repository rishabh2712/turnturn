// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatTransport, ConversationSummary, LiveSubscriptionHandlers } from "@turnturn/chat-client";
import {
  CommandTypes,
  DurableRecordTypes as Durable,
  type DurableRecord,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatTurnId,
  LiveEventTypes,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { TransportProvider } from "../src/providers/TransportProvider";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

test("Stop sends the active turn scope once and waits for the durable aborted outcome", async () => {
  const conversationId = formatConversationId("11111111-1111-4111-8111-111111111111");
  const sessionId = formatSessionId("22222222-2222-4222-8222-222222222222");
  const turnId = formatTurnId("33333333-3333-4333-8333-333333333333");
  const createdAt = "2026-09-22T00:00:00Z";
  const record = (sequence: number, type: Durable, payload: object, scope: object = {}) =>
    ({
      schemaVersion: SCHEMA_VERSION,
      recordId: formatRecordId(`44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`),
      sequence,
      type,
      createdAt,
      conversationId,
      sessionId,
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
  const summary: ConversationSummary = {
    conversationId,
    workspaceKey: "ws",
    title: "Running turn",
    titleSource: "auto",
    createdAt,
    lastActivityAt: createdAt,
    archived: false,
    sessionCount: 1,
  };
  let finishCancel: ((outcome: { kind: "accepted" }) => void) | undefined;
  const cancelResponse = new Promise<{ kind: "accepted" }>((resolve) => {
    finishCancel = resolve;
  });
  let handlers: LiveSubscriptionHandlers | undefined;
  const transport = {
    getRuntime: vi.fn(async () => ({
      workspace: { key: "ws", path: "/workspace", name: "workspace" },
      provider: "test",
      model: "test",
      defaultModelProfileId: "test",
      models: [{ id: "test", label: "Test", provider: "test", model: "test" }],
      baseUrlHost: null,
      maxTokens: null,
      serverInstanceId: "server",
      storageVersion: 1,
      schemaVersion: 1,
      tools: [],
    })),
    listProviders: vi.fn(async () => ({ connections: [] })),
    listConversations: vi.fn(async ({ archived = false } = {}) => ({
      conversations: archived ? [] : [summary],
      nextCursor: null,
    })),
    getConversation: vi.fn(async () => ({
      conversation: summary,
      sessions: [{ sessionId, ordinal: 0, provider: "test", model: "test", createdAt, lastSequence: records.length }],
    })),
    getRecords: vi.fn(async (_id, _session, afterSequence: number) => ({
      sessionId,
      records: records.filter((item) => item.sequence > afterSequence),
      lastSequence: records.length,
      hasMore: false,
    })),
    submitCommand: vi.fn(() => cancelResponse),
    subscribeEvents: vi.fn((_id, nextHandlers: LiveSubscriptionHandlers) => {
      handlers = nextHandlers;
      queueMicrotask(() =>
        nextHandlers.onSnapshot({
          conversationId,
          serverInstanceId: "server",
          sessions: [{ sessionId, lastSequence: records.length }],
        }),
      );
      return () => {};
    }),
  } as unknown as ChatTransport;

  render(
    <TransportProvider transport={transport}>
      <App />
    </TransportProvider>,
  );
  const stop = await screen.findByRole("button", { name: "Stop" });
  fireEvent.click(stop);
  fireEvent.click(stop);
  await waitFor(() =>
    expect(transport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CommandTypes.TurnCancel,
        conversationId,
        sessionId,
        turnId,
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeDefined();
  expect(screen.queryByText("Stopped")).toBeNull();
  expect(transport.submitCommand).toHaveBeenCalledTimes(1);

  finishCancel?.({ kind: "accepted" });
  await waitFor(() => expect(transport.getRecords).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeDefined();
  expect(screen.queryByText("Stopped")).toBeNull();

  records.push(record(5, Durable.TurnAborted, { reason: "Stopped by user" }, { turnId }));
  expect(reduceEngineState(records).issues).toEqual([]);
  handlers?.onEvent({
    schemaVersion: SCHEMA_VERSION,
    eventId: formatEventId("55555555-5555-4555-8555-555555555555"),
    type: LiveEventTypes.TurnAborted,
    createdAt,
    conversationId,
    sessionId,
    turnId,
    payload: { reason: "Stopped by user" },
  });
  await screen.findByText("Stopped");
  expect(screen.queryByRole("button", { name: "Stopping…" })).toBeNull();
  expect(transport.submitCommand).toHaveBeenCalledTimes(1);
});
