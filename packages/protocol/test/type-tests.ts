import { CommandTypes, DurableRecordTypes, LiveEventTypes } from "../src/index.js";
import type { CommandEnvelope, DurableRecord, DurableRecordDraft, LiveEvent, ConversationId, SessionId, TurnId, StepId, ToolCallId, ApprovalId, CommandId, RecordId, EventId } from "../src/index.js";

declare const conversationId: ConversationId;
declare const sessionId: SessionId;
declare const turnId: TurnId;
declare const stepId: StepId;
declare const toolCallId: ToolCallId;
declare const approvalId: ApprovalId;
declare const commandId: CommandId;
declare const recordId: RecordId;
declare const eventId: EventId;

const command: CommandEnvelope<CommandTypes.TurnSubmit> = {
  schemaVersion: 1, commandId, type: CommandTypes.TurnSubmit, createdAt: "2026-01-01T00:00:00.000Z",
  conversationId, sessionId, turnId, payload: { input: "hello" }
};
const draft: DurableRecordDraft<DurableRecordTypes.ToolRequested> = {
  schemaVersion: 1, recordId, type: DurableRecordTypes.ToolRequested, createdAt: "2026-01-01T00:00:00.000Z",
  conversationId, sessionId, turnId, stepId, toolCallId, payload: { name: "sh", input: {}, providerOrder: 0, requiresApproval: true }
};
const live: LiveEvent<LiveEventTypes.ContentDelta> = {
  schemaVersion: 1, eventId, type: LiveEventTypes.ContentDelta, createdAt: "2026-01-01T00:00:00.000Z",
  conversationId, sessionId, turnId, payload: { text: "hi" }
};
void command; void draft; void live;

// @ts-expect-error semantic ID brands are intentionally incompatible
const wrongScope: CommandEnvelope<CommandTypes.TurnSubmit> = { ...command, sessionId: turnId };
// @ts-expect-error live events cannot carry durable sequence numbers
const liveSequence: LiveEvent<LiveEventTypes.Warning> = { ...live, sequence: 1, type: LiveEventTypes.Warning, payload: { message: "x" } };
// @ts-expect-error drafts cannot carry writer-assigned sequence numbers
const draftSequence: DurableRecordDraft<DurableRecordTypes.TurnStarted> = { ...draft, sequence: 1, type: DurableRecordTypes.TurnStarted, payload: { input: "x" } };
const persisted: DurableRecord<DurableRecordTypes.ToolRequested> = { ...draft, sequence: 1 };
const { sessionId: omittedSession, ...withoutSession } = persisted;
// @ts-expect-error every durable record requires session scope
const missingDurableSession: DurableRecord = withoutSession;
const approval: CommandEnvelope<CommandTypes.ApprovalResolve> = { ...command, type: CommandTypes.ApprovalResolve, toolCallId, approvalId, payload: { decision: "allow" } };
const { approvalId: omittedApproval, ...withoutApproval } = approval;
const { toolCallId: omittedTool, ...withoutTool } = approval;
// @ts-expect-error approval resolution requires its approval ID
const missingApproval: CommandEnvelope = withoutApproval;
// @ts-expect-error approval resolution requires its tool ID independently
const missingTool: CommandEnvelope = withoutTool;
// @ts-expect-error the default union must preserve the command/payload relationship
const wrongCommandPayload: CommandEnvelope = { ...command, payload: { decision: "deny" } };
// @ts-expect-error the default durable union must preserve the type/payload relationship
const wrongRecordPayload: DurableRecord = { ...persisted, payload: { content: "wrong" } };
// @ts-expect-error the default live union must preserve the type/payload relationship
const wrongLivePayload: LiveEvent = { ...live, payload: { decision: "allow" } };

declare const anyRecord: DurableRecord;
if (anyRecord.type === DurableRecordTypes.ToolRequested) {
  const providerOrder: number = anyRecord.payload.providerOrder;
  void providerOrder;
}
