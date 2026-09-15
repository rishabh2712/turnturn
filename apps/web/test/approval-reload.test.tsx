// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatTransport, ConversationSummary, LiveSubscriptionHandlers } from "@turnturn/chat-client";
import {
  DurableRecordTypes as Durable,
  type DurableRecord,
  formatApprovalId,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
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

test("a saved pending edit approval survives a UI reload and Deny dispatches its exact scope", async () => {
  const conversationId = formatConversationId("11111111-1111-4111-8111-111111111111");
  const sessionId = formatSessionId("22222222-2222-4222-8222-222222222222");
  const turnId = formatTurnId("33333333-3333-4333-8333-333333333333");
  const stepId = formatStepId("44444444-4444-4444-8444-444444444444");
  const toolCallId = formatToolCallId("55555555-5555-4555-8555-555555555555");
  const approvalId = formatApprovalId("66666666-6666-4666-8666-666666666666");
  const base = { schemaVersion: SCHEMA_VERSION, createdAt: "2026-09-14T00:00:00Z", conversationId, sessionId };
  const record = (sequence: number, type: Durable, payload: object, scope: object = {}) =>
    ({
      ...base,
      recordId: formatRecordId(`77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`),
      sequence,
      type,
      payload,
      ...scope,
    }) as DurableRecord;
  const records = [
    record(1, Durable.ConversationCreated, {}),
    record(2, Durable.SessionCreated, {}),
    record(3, Durable.TurnStarted, { input: "Edit a.ts" }, { turnId }),
    record(4, Durable.UserInputAccepted, { text: "Edit a.ts" }, { turnId }),
    record(5, Durable.ProviderStepStarted, {}, { turnId, stepId }),
    record(6, Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId, stepId }),
    record(
      7,
      Durable.ToolRequested,
      { name: "edit", input: { path: "a.ts", oldText: "x", newText: "y" }, providerOrder: 0, requiresApproval: true },
      { turnId, stepId, toolCallId },
    ),
    record(8, Durable.ApprovalRequested, { reason: "Edit a.ts" }, { turnId, toolCallId, approvalId }),
  ];
  expect(reduceEngineState(records).issues).toEqual([]);
  const summary: ConversationSummary = {
    conversationId,
    workspaceKey: "ws",
    title: "Edit test",
    titleSource: "auto",
    createdAt: base.createdAt,
    lastActivityAt: base.createdAt,
    archived: false,
    sessionCount: 1,
  };
  const transport = {
    getRuntime: vi.fn(async () => ({
      workspace: { key: "ws", path: "/workspace", name: "workspace" },
      provider: "test",
      model: "test",
      baseUrlHost: null,
      maxTokens: null,
      serverInstanceId: "server",
      storageVersion: 1,
      schemaVersion: 1,
      tools: [],
    })),
    listConversations: vi.fn(async ({ archived = false } = {}) => ({
      conversations: archived ? [] : [summary],
      nextCursor: null,
    })),
    getConversation: vi.fn(async () => ({
      conversation: summary,
      sessions: [
        {
          sessionId,
          ordinal: 0,
          provider: "test",
          model: "test",
          createdAt: base.createdAt,
          lastSequence: records.length,
        },
      ],
    })),
    getRecords: vi.fn(async () => ({ sessionId, records, lastSequence: records.length, hasMore: false })),
    submitCommand: vi.fn(async () => ({ kind: "accepted" as const })),
    subscribeEvents: vi.fn((_id, handlers: LiveSubscriptionHandlers) => {
      queueMicrotask(() =>
        handlers.onSnapshot({
          conversationId,
          serverInstanceId: "server",
          sessions: [{ sessionId, lastSequence: records.length }],
        }),
      );
      return () => {};
    }),
  } as unknown as ChatTransport;

  const mount = () =>
    render(
      <TransportProvider transport={transport}>
        <App />
      </TransportProvider>,
    );
  mount();
  expect(await screen.findByRole("button", { name: "Allow" })).toBeDefined();
  cleanup(); // the browser reload discards all React state and the in-memory store
  mount();
  expect(await screen.findByRole("button", { name: "Deny" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(transport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "approval.resolve",
        conversationId,
        sessionId,
        turnId,
        toolCallId,
        approvalId,
        payload: { decision: "deny" },
      }),
    ),
  );
});
