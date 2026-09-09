import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalDecisions,
  DurableRecordTypes,
  formatApprovalId,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId
} from "../dist/index.js";
import {
  ApprovalStatuses,
  EngineStateIssueCodes,
  reduceEngineState,
  StepStatuses,
  ToolStatuses,
  TurnStatuses
} from "../dist/engine-state.js";

const uuid = n => `018f1f4e-8d5f-7abc-8123-223456789${String(n).padStart(3, "0")}`;
const ids = {
  conversationId: formatConversationId(uuid(1)),
  sessionId: formatSessionId(uuid(2)),
  turnId: formatTurnId(uuid(3)),
  stepId: formatStepId(uuid(4)),
  toolCallId: formatToolCallId(uuid(5)),
  approvalId: formatApprovalId(uuid(6))
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

function happyPathRecords() {
  return [
    record(1, DurableRecordTypes.ConversationCreated, { title: "Demo" }),
    record(2, DurableRecordTypes.SessionCreated, { provider: "test" }),
    record(3, DurableRecordTypes.TurnStarted, { input: "hello" }, { turnId: ids.turnId }),
    record(4, DurableRecordTypes.UserInputAccepted, { text: "hello" }, { turnId: ids.turnId }),
    record(5, DurableRecordTypes.ProviderStepStarted, { provider: "test" }, { turnId: ids.turnId, stepId: ids.stepId }),
    record(6, DurableRecordTypes.ToolRequested, { name: "sh", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId }),
    record(7, DurableRecordTypes.ApprovalRequested, { reason: "run command" }, { turnId: ids.turnId, toolCallId: ids.toolCallId, approvalId: ids.approvalId }),
    record(8, DurableRecordTypes.ApprovalResolved, { decision: ApprovalDecisions.Allow }, { turnId: ids.turnId, toolCallId: ids.toolCallId, approvalId: ids.approvalId }),
    record(9, DurableRecordTypes.ToolResultCompleted, { output: "ok" }, { turnId: ids.turnId, toolCallId: ids.toolCallId }),
    record(10, DurableRecordTypes.ProviderStepCompleted, { stopReason: "stop" }, { turnId: ids.turnId, stepId: ids.stepId }),
    record(11, DurableRecordTypes.AssistantMessageCompleted, { content: "done" }, { turnId: ids.turnId }),
    record(12, DurableRecordTypes.TurnCompleted, { stopReason: "stop" }, { turnId: ids.turnId })
  ];
}

test("engine-state reducer reconstructs turn, tool, approval, and step state", () => {
  const state = reduceEngineState(happyPathRecords());

  assert.deepEqual(state.issues, []);
  assert.equal(state.lastSequence, 12);
  assert.equal(state.conversations.get(ids.conversationId).title, "Demo");
  assert.equal(state.sessions.get(ids.sessionId).provider, "test");
  assert.equal(state.turns.get(ids.turnId).status, TurnStatuses.Completed);
  assert.deepEqual(state.turns.get(ids.turnId).assistantMessages, ["done"]);
  assert.equal(state.steps.get(ids.stepId).status, StepStatuses.Completed);
  assert.equal(state.tools.get(ids.toolCallId).status, ToolStatuses.Completed);
  assert.equal(state.tools.get(ids.toolCallId).approvalId, ids.approvalId);
  assert.equal(state.approvals.get(ids.approvalId).status, ApprovalStatuses.Allowed);
});

test("engine-state reducer records missing parent issues without dropping recoverable state", () => {
  const state = reduceEngineState([
    record(1, DurableRecordTypes.ToolRequested, { name: "sh", input: {}, providerOrder: 0, requiresApproval: false }, { turnId: ids.turnId, stepId: ids.stepId, toolCallId: ids.toolCallId })
  ]);

  assert.equal(state.tools.get(ids.toolCallId).status, ToolStatuses.Requested);
  assert.equal(state.issues.length, 2);
  assert.deepEqual(state.issues.map(issue => issue.code), [EngineStateIssueCodes.MissingParent, EngineStateIssueCodes.MissingParent]);
});

test("engine-state reducer rejects terminal mutations", () => {
  const records = happyPathRecords();
  const terminalAgain = record(13, DurableRecordTypes.ToolResultFailed, { error }, { turnId: ids.turnId, toolCallId: ids.toolCallId });
  const lateAssistant = record(14, DurableRecordTypes.AssistantMessageCompleted, { content: "late" }, { turnId: ids.turnId });
  const state = reduceEngineState([...records, terminalAgain, lateAssistant]);

  assert.equal(state.tools.get(ids.toolCallId).status, ToolStatuses.Completed);
  assert.deepEqual(state.issues.map(issue => issue.code), [EngineStateIssueCodes.InvalidTransition, EngineStateIssueCodes.InvalidTransition]);
});

test("engine-state reducer detects out-of-order records", () => {
  const records = happyPathRecords();
  const state = reduceEngineState([records[0], { ...records[1], sequence: 4 }]);

  assert.equal(state.lastSequence, 4);
  assert.equal(state.issues[0].code, EngineStateIssueCodes.OutOfOrder);
});

test("engine-state reducer ignores duplicate entity creation after reporting it", () => {
  const duplicate = { ...happyPathRecords()[0], recordId: formatRecordId(uuid(999)), sequence: 2, payload: { title: "Other" } };
  const state = reduceEngineState([happyPathRecords()[0], duplicate]);

  assert.equal(state.conversations.get(ids.conversationId).title, "Demo");
  assert.equal(state.issues[0].code, EngineStateIssueCodes.DuplicateEntity);
});
