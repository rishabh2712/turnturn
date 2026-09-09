import { ApprovalDecisions, CommandTypes, DurableRecordTypes, LiveEventTypes, formatApprovalId, formatCommandId, formatConversationId, formatEventId, formatRecordId, formatSessionId, formatStepId, formatToolCallId, formatTurnId } from "./index.js";
import type { CommandEnvelope, DurableRecord, LiveEvent } from "./index.js";

const uuid = (n: string) => `018f1f4e-8d5f-7abc-8123-123456789${n.padStart(3, "0")}`;
export const fixtureIds = {
  conversationId: formatConversationId(uuid("001")), sessionId: formatSessionId(uuid("002")), turnId: formatTurnId(uuid("003")),
  stepId: formatStepId(uuid("004")), toolCallId: formatToolCallId(uuid("005")), approvalId: formatApprovalId(uuid("006")),
  eventId: formatEventId(uuid("007"))
};

const command = (n: string) => formatCommandId(uuid(n));
const record = (n: string) => formatRecordId(uuid(n));
const base = { schemaVersion: 1 as const, createdAt: "2026-01-01T00:00:00.000Z", conversationId: fixtureIds.conversationId, sessionId: fixtureIds.sessionId };

// These are independent JSON serialization examples, not one replayable history.
export const commandFixtures = [
  { ...base, commandId: command("101"), type: CommandTypes.ConversationCreate, payload: { title: "Demo" } },
  { ...base, commandId: command("102"), type: CommandTypes.SessionCreate, payload: { provider: "test" } },
  { ...base, commandId: command("103"), type: CommandTypes.TurnSubmit, turnId: fixtureIds.turnId, payload: { input: "hello" } },
  { ...base, commandId: command("104"), type: CommandTypes.ApprovalResolve, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, approvalId: fixtureIds.approvalId, payload: { decision: ApprovalDecisions.Allow } },
  { ...base, commandId: command("105"), idempotencyKey: "duplicate-turn-cancel", type: CommandTypes.TurnCancel, turnId: fixtureIds.turnId, payload: { reason: "user" } },
  { ...base, commandId: command("106"), type: CommandTypes.ToolCancel, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, payload: { reason: "timeout" } }
] satisfies CommandEnvelope[];

const error = { code: "FAILED", message: "operation failed", retryable: false, fatal: false, cause: { code: "ROOT", message: "root cause", retryable: true, fatal: false }, details: { provider: "test", attempt: 2 } } as const;
export const durableFixtures = [
  { ...base, recordId: record("201"), sequence: 1, type: DurableRecordTypes.ConversationCreated, payload: { title: "Demo" } },
  { ...base, recordId: record("202"), sequence: 2, type: DurableRecordTypes.SessionCreated, payload: { provider: "test" } },
  { ...base, recordId: record("203"), sequence: 3, type: DurableRecordTypes.TurnStarted, turnId: fixtureIds.turnId, payload: { input: "hello" } },
  { ...base, recordId: record("204"), sequence: 4, type: DurableRecordTypes.UserInputAccepted, turnId: fixtureIds.turnId, payload: { text: "hello" } },
  { ...base, recordId: record("205"), sequence: 5, type: DurableRecordTypes.AssistantMessageCompleted, turnId: fixtureIds.turnId, payload: { content: "done" } },
  { ...base, recordId: record("206"), sequence: 6, type: DurableRecordTypes.ProviderStepStarted, turnId: fixtureIds.turnId, stepId: fixtureIds.stepId, payload: {} },
  { ...base, recordId: record("207"), sequence: 7, type: DurableRecordTypes.ProviderStepCompleted, turnId: fixtureIds.turnId, stepId: fixtureIds.stepId, payload: { stopReason: "tool_use" } },
  { ...base, recordId: record("208"), sequence: 8, type: DurableRecordTypes.ProviderStepFailed, turnId: fixtureIds.turnId, stepId: fixtureIds.stepId, payload: { error } },
  { ...base, recordId: record("209"), sequence: 9, type: DurableRecordTypes.ToolRequested, turnId: fixtureIds.turnId, stepId: fixtureIds.stepId, toolCallId: fixtureIds.toolCallId, payload: { name: "sh", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true, providerToolCallId: "provider-call-0" } },
  { ...base, recordId: record("210"), sequence: 10, type: DurableRecordTypes.ApprovalRequested, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, approvalId: fixtureIds.approvalId, payload: { reason: "run command" } },
  { ...base, recordId: record("211"), sequence: 11, type: DurableRecordTypes.ApprovalResolved, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, approvalId: fixtureIds.approvalId, payload: { decision: ApprovalDecisions.Allow } },
  { ...base, recordId: record("212"), sequence: 12, type: DurableRecordTypes.ToolResultCompleted, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, payload: { output: "ok", cancellation: { requested: true, reason: "stop after completion" } } },
  { ...base, recordId: record("213"), sequence: 13, type: DurableRecordTypes.ToolResultFailed, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, payload: { error, cancellation: { requested: true, reason: "cancelled" } } },
  { ...base, recordId: record("214"), sequence: 14, type: DurableRecordTypes.ToolResultDenied, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, payload: { error: { ...error, code: "DENIED" }, synthetic: true } },
  { ...base, recordId: record("215"), sequence: 15, type: DurableRecordTypes.ToolResultAborted, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, payload: { error: { ...error, code: "ABORTED" }, synthetic: true } },
  { ...base, recordId: record("216"), sequence: 16, type: DurableRecordTypes.TurnCompleted, turnId: fixtureIds.turnId, payload: { stopReason: "stop" } },
  { ...base, recordId: record("217"), sequence: 17, type: DurableRecordTypes.TurnFailed, turnId: fixtureIds.turnId, payload: { error } },
  { ...base, recordId: record("218"), sequence: 18, type: DurableRecordTypes.TurnAborted, turnId: fixtureIds.turnId, payload: { reason: "cancelled" } }
] satisfies DurableRecord[];

export const liveFixtures = [
  { ...base, eventId: fixtureIds.eventId, type: LiveEventTypes.ContentDelta, turnId: fixtureIds.turnId, payload: { text: "hi" } },
  { ...base, eventId: fixtureIds.eventId, type: LiveEventTypes.ApprovalRequested, turnId: fixtureIds.turnId, toolCallId: fixtureIds.toolCallId, approvalId: fixtureIds.approvalId, payload: { reason: "run" } },
  { ...base, eventId: fixtureIds.eventId, type: LiveEventTypes.Warning, payload: { message: "duplicate approval", code: "DUPLICATE" } }
] satisfies LiveEvent[];
