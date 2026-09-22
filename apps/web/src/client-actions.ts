import type {
  ApprovalRequestItem,
  ChatTransport,
  ConversationStore,
  TransportCommandResult,
} from "@turnturn/chat-client";
import {
  type ApprovalDecisions,
  CommandTypes,
  type ConversationId,
  formatCommandId,
  formatTurnId,
  SCHEMA_VERSION,
  type SessionId,
  type TurnId,
} from "@turnturn/protocol";

/** The initial dogfood send path. The visual composer never constructs a command. */
export async function sendTurn(
  transport: ChatTransport,
  store: ConversationStore,
  conversationId: ConversationId,
  input: string,
  modelProfileId?: string,
): Promise<TurnId> {
  const text = input.trim();
  if (text.length === 0) throw new Error("Message is empty");
  const session = await transport.activateConversation(
    conversationId,
    modelProfileId === undefined ? {} : { modelProfileId },
  );
  store.registerSession(session.sessionId, session.ordinal, session.provider, session.model);
  const turnId = formatTurnId(crypto.randomUUID());
  const commandId = formatCommandId(crypto.randomUUID());
  store.setOptimistic(session.sessionId, turnId, text);
  try {
    const result = await transport.submitCommand({
      schemaVersion: SCHEMA_VERSION,
      commandId,
      idempotencyKey: commandId,
      type: CommandTypes.TurnSubmit,
      createdAt: new Date().toISOString(),
      conversationId,
      sessionId: session.sessionId,
      turnId,
      payload: { input: text },
    });
    if (result.kind === "rejected") throw new Error(`${result.code}: ${result.message}`);
    return turnId;
  } catch (error) {
    store.clearOptimistic(session.sessionId);
    throw error;
  }
}

/** Sends a cancellation request; only a durable terminal record confirms the turn's outcome. */
export function requestTurnCancel(
  transport: ChatTransport,
  conversationId: ConversationId,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<TransportCommandResult> {
  const commandId = formatCommandId(crypto.randomUUID());
  return transport.submitCommand({
    schemaVersion: SCHEMA_VERSION,
    commandId,
    idempotencyKey: commandId,
    type: CommandTypes.TurnCancel,
    createdAt: new Date().toISOString(),
    conversationId,
    sessionId,
    turnId,
    payload: { reason: "Stopped by user" },
  });
}

/** Resolves only the approval identified by the projected durable request. */
export async function resolveApproval(
  transport: ChatTransport,
  conversationId: ConversationId,
  approval: ApprovalRequestItem,
  decision: ApprovalDecisions,
): Promise<"accepted" | "cancelled"> {
  const commandId = formatCommandId(crypto.randomUUID());
  const result = await transport.submitCommand({
    schemaVersion: SCHEMA_VERSION,
    commandId,
    idempotencyKey: commandId,
    type: CommandTypes.ApprovalResolve,
    createdAt: new Date().toISOString(),
    conversationId,
    sessionId: approval.sessionId,
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    approvalId: approval.approvalId,
    payload: { decision },
  });
  if (result.kind === "rejected") {
    if (result.code === "APPROVAL_NOT_PENDING") return "cancelled";
    throw new Error(`${result.code}: ${result.message}`);
  }
  return "accepted";
}
