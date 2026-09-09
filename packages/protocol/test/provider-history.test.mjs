import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableRecordTypes,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId
} from "../dist/index.js";
import {
  ProviderHistoryIssueCodes,
  ProviderHistoryItemTypes,
  ProviderToolResultStatuses,
  reduceProviderHistory
} from "../dist/provider-history.js";

const uuid = n => `018f1f4e-8d5f-7abc-8123-323456789${String(n).padStart(3, "0")}`;
const ids = {
  conversationId: formatConversationId(uuid(1)),
  sessionId: formatSessionId(uuid(2)),
  turnId: formatTurnId(uuid(3)),
  stepId: formatStepId(uuid(4)),
  toolCallId: formatToolCallId(uuid(5)),
  secondToolCallId: formatToolCallId(uuid(6))
};
const error = { code: "FAILED", message: "failed", retryable: false, fatal: false };

function record(sequence, type, payload, scope = {}) {
  return {
    schemaVersion: 1,
    recordId: formatRecordId(uuid(100 + sequence)),
    sequence,
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    payload,
    ...scope
  };
}

test("provider-history reducer reconstructs only model-visible items", () => {
  const history = reduceProviderHistory([
    record(1, DurableRecordTypes.ConversationCreated, { title: "Demo" }),
    record(2, DurableRecordTypes.SessionCreated, { provider: "test" }),
    record(3, DurableRecordTypes.TurnStarted, { input: "hello" }, { turnId: ids.turnId }),
    record(4, DurableRecordTypes.UserInputAccepted, { text: "hello" }, { turnId: ids.turnId }),
    record(5, DurableRecordTypes.ProviderStepStarted, { provider: "test" }, { turnId: ids.turnId, stepId: ids.stepId }),
    record(6, DurableRecordTypes.ToolRequested, { name: "sh", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true, providerToolCallId: "native-call" }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId }),
    record(7, DurableRecordTypes.ToolResultCompleted, { output: "ok" }, { turnId: ids.turnId, toolCallId: ids.toolCallId }),
    record(8, DurableRecordTypes.ProviderStepCompleted, { stopReason: "stop" }, { turnId: ids.turnId, stepId: ids.stepId }),
    record(9, DurableRecordTypes.AssistantMessageCompleted, { content: "done" }, { turnId: ids.turnId }),
    record(10, DurableRecordTypes.TurnCompleted, { stopReason: "stop" }, { turnId: ids.turnId })
  ]);

  assert.deepEqual(history.issues, []);
  assert.equal(history.lastSequence, 10);
  assert.deepEqual(history.items.map(item => item.type), [
    ProviderHistoryItemTypes.UserInput,
    ProviderHistoryItemTypes.ToolRequest,
    ProviderHistoryItemTypes.ToolResult,
    ProviderHistoryItemTypes.AssistantMessage
  ]);
  assert.equal(history.items[1].providerToolCallId, "native-call");
  assert.equal(history.items[2].status, ProviderToolResultStatuses.Completed);
  assert.equal(history.items[2].synthetic, false);
});

test("provider-history reducer preserves provider order metadata for same-step tool requests", () => {
  const history = reduceProviderHistory([
    record(1, DurableRecordTypes.UserInputAccepted, { text: "run both" }, { turnId: ids.turnId }),
    record(2, DurableRecordTypes.ToolRequested, { name: "read", input: { path: "a" }, providerOrder: 0, requiresApproval: false }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId }),
    record(3, DurableRecordTypes.ToolRequested, { name: "read", input: { path: "b" }, providerOrder: 1, requiresApproval: false }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.secondToolCallId }),
    record(4, DurableRecordTypes.ToolResultCompleted, { output: "a" }, { turnId: ids.turnId, toolCallId: ids.toolCallId }),
    record(5, DurableRecordTypes.ToolResultCompleted, { output: "b" }, { turnId: ids.turnId, toolCallId: ids.secondToolCallId })
  ]);

  const requests = history.items.filter(item => item.type === ProviderHistoryItemTypes.ToolRequest);
  assert.deepEqual(requests.map(item => item.providerOrder), [0, 1]);
  assert.deepEqual(requests.map(item => item.toolCallId), [ids.toolCallId, ids.secondToolCallId]);
});

test("provider-history reducer records terminal synthetic tool results", () => {
  const denied = reduceProviderHistory([
    record(1, DurableRecordTypes.ToolRequested, { name: "sh", input: {}, providerOrder: 0, requiresApproval: true }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId }),
    record(2, DurableRecordTypes.ToolResultDenied, { error, synthetic: true }, { turnId: ids.turnId, toolCallId: ids.toolCallId })
  ]);
  const aborted = reduceProviderHistory([
    record(1, DurableRecordTypes.ToolRequested, { name: "sh", input: {}, providerOrder: 0, requiresApproval: true }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId }),
    record(2, DurableRecordTypes.ToolResultAborted, { error, synthetic: true }, { turnId: ids.turnId, toolCallId: ids.toolCallId })
  ]);

  assert.equal(denied.items[1].status, ProviderToolResultStatuses.Denied);
  assert.equal(denied.items[1].synthetic, true);
  assert.equal(aborted.items[1].status, ProviderToolResultStatuses.Aborted);
  assert.equal(aborted.items[1].synthetic, true);
});

test("provider-history reducer reports missing and duplicate tool results", () => {
  const history = reduceProviderHistory([
    record(1, DurableRecordTypes.ToolResultCompleted, { output: "orphan" }, { turnId: ids.turnId, toolCallId: ids.toolCallId }),
    record(2, DurableRecordTypes.ToolResultFailed, { error }, { turnId: ids.turnId, toolCallId: ids.toolCallId })
  ]);

  assert.deepEqual(history.issues.map(issue => issue.code), [
    ProviderHistoryIssueCodes.MissingToolRequest,
    ProviderHistoryIssueCodes.MissingToolRequest,
    ProviderHistoryIssueCodes.DuplicateToolResult
  ]);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].status, ProviderToolResultStatuses.Completed);
});

test("provider-history reducer detects out-of-order records", () => {
  const history = reduceProviderHistory([
    record(1, DurableRecordTypes.UserInputAccepted, { text: "hello" }, { turnId: ids.turnId }),
    record(4, DurableRecordTypes.AssistantMessageCompleted, { content: "late" }, { turnId: ids.turnId })
  ]);

  assert.equal(history.lastSequence, 4);
  assert.equal(history.issues[0].code, ProviderHistoryIssueCodes.OutOfOrder);
});
