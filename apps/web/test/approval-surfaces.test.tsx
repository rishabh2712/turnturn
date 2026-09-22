// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatTransport, ConversationSummary, LiveSubscriptionHandlers } from "@turnturn/chat-client";
import {
  ApprovalDecisions,
  DurableRecordTypes as Durable,
  type DurableRecord,
  formatApprovalId,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
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

function approvalScenario() {
  const conversationId = formatConversationId("11111111-1111-4111-8111-111111111111");
  const sessionId = formatSessionId("22222222-2222-4222-8222-222222222222");
  const turnId = formatTurnId("33333333-3333-4333-8333-333333333333");
  const stepId = formatStepId("44444444-4444-4444-8444-444444444444");
  const toolCallId = formatToolCallId("55555555-5555-4555-8555-555555555555");
  const approvalId = formatApprovalId("66666666-6666-4666-8666-666666666666");
  const createdAt = "2026-09-22T00:00:00Z";
  const record = (sequence: number, type: Durable, payload: object, scope: object = {}) =>
    ({
      schemaVersion: SCHEMA_VERSION,
      recordId: formatRecordId(`77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`),
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
    createdAt,
    lastActivityAt: createdAt,
    archived: false,
    sessionCount: 1,
  };
  let handlers: LiveSubscriptionHandlers | undefined;
  let resolveCommand:
    | ((outcome: { kind: "accepted" } | { kind: "rejected"; code: string; message: string }) => void)
    | undefined;
  const commandResponse = new Promise<{ kind: "accepted" } | { kind: "rejected"; code: string; message: string }>(
    (resolve) => {
      resolveCommand = resolve;
    },
  );
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
    submitCommand: vi.fn(() => commandResponse),
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
  function mount() {
    render(
      <TransportProvider transport={transport}>
        <App />
      </TransportProvider>,
    );
  }
  function recordDecision(decision: ApprovalDecisions) {
    records.push(record(9, Durable.ApprovalResolved, { decision }, { turnId, toolCallId, approvalId }));
    expect(reduceEngineState(records).issues).toEqual([]);
    handlers?.onEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: formatEventId("88888888-8888-4888-8888-888888888888"),
      type: LiveEventTypes.ApprovalResolved,
      createdAt,
      conversationId,
      sessionId,
      turnId,
      toolCallId,
      approvalId,
      payload: { decision },
    });
  }
  return {
    mount,
    transport,
    approvalId,
    recordDecision,
    resolveCommand: (outcome: Parameters<NonNullable<typeof resolveCommand>>[0]) => resolveCommand?.(outcome),
  };
}

test("inline and persistent approvals share one pending command, then show the durable choice", async () => {
  const scenario = approvalScenario();
  scenario.mount();
  const inline = await screen.findByRole("region", { name: "Approval needed for edit" });
  const bar = await screen.findByRole("region", { name: "Pending action" });
  const transcript = document.querySelector(".tt-transcript");
  if (!(transcript instanceof HTMLElement)) throw new Error("Transcript missing");
  transcript.scrollTop = 1200;
  fireEvent.scroll(transcript);
  expect(transcript.contains(inline)).toBe(true);
  expect(transcript.contains(bar)).toBe(false);
  expect(within(bar).getByText(/Edit a.ts/)).toBeDefined();
  expect(within(bar).getByText(/"path": "a.ts"/)).toBeDefined();
  fireEvent.click(within(bar).getByRole("button", { name: "Allow" }));
  expect(within(inline).getByText("Resolving…")).toBeDefined();
  expect(within(bar).getByText("Resolving…")).toBeDefined();
  fireEvent.click(within(inline).getByRole("button", { name: "Deny" }));
  expect(scenario.transport.submitCommand).toHaveBeenCalledTimes(1);
  expect(scenario.transport.submitCommand).toHaveBeenCalledWith(
    expect.objectContaining({ approvalId: scenario.approvalId, payload: { decision: ApprovalDecisions.Allow } }),
  );
  scenario.resolveCommand({ kind: "accepted" });
  await waitFor(() => expect(scenario.transport.getRecords).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Allowed")).toBeNull();
  scenario.recordDecision(ApprovalDecisions.Allow);
  await screen.findByText("Allowed");
  expect(screen.queryByRole("region", { name: "Pending action" })).toBeNull();
  expect(screen.queryByText("Edit completed")).toBeNull();
});

test("a stale approval refreshes to the other client's decision without claiming the clicked choice", async () => {
  const scenario = approvalScenario();
  scenario.mount();
  const inline = await screen.findByRole("region", { name: "Approval needed for edit" });
  fireEvent.click(within(inline).getByRole("button", { name: "Allow" }));
  scenario.recordDecision(ApprovalDecisions.Deny);
  scenario.resolveCommand({ kind: "rejected", code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" });
  await screen.findByText("Denied");
  expect(screen.queryByText("Allowed")).toBeNull();
  expect(screen.queryByRole("region", { name: "Pending action" })).toBeNull();
});

test("a failed approval command leaves both surfaces actionable with the same error", async () => {
  const scenario = approvalScenario();
  scenario.mount();
  const inline = await screen.findByRole("region", { name: "Approval needed for edit" });
  const bar = await screen.findByRole("region", { name: "Pending action" });
  fireEvent.click(within(inline).getByRole("button", { name: "Deny" }));
  scenario.resolveCommand({ kind: "rejected", code: "TEMPORARY_FAILURE", message: "Try again" });
  expect(await within(inline).findByText("TEMPORARY_FAILURE: Try again")).toBeDefined();
  expect(within(bar).getByText("TEMPORARY_FAILURE: Try again")).toBeDefined();
  expect(within(inline).getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(false);
  expect(within(bar).getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByText("Denied")).toBeNull();
});

test("a confirmed command with failed catch-up stays locked until the saved decision arrives", async () => {
  const scenario = approvalScenario();
  scenario.mount();
  const inline = await screen.findByRole("region", { name: "Approval needed for edit" });
  const bar = await screen.findByRole("region", { name: "Pending action" });
  vi.mocked(scenario.transport.getRecords).mockRejectedValueOnce(new Error("Catch-up unavailable"));
  fireEvent.click(within(bar).getByRole("button", { name: "Allow" }));
  scenario.resolveCommand({ kind: "accepted" });
  expect(await within(bar).findByText(/Decision sent; waiting for saved confirmation/)).toBeDefined();
  expect(within(inline).getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
  expect(scenario.transport.submitCommand).toHaveBeenCalledTimes(1);
  scenario.recordDecision(ApprovalDecisions.Allow);
  await screen.findByText("Allowed");
});
