import { randomUUID } from "node:crypto";
import type { EngineClock, EngineIds } from "@turnturn/assistant-core/ports";
import {
  type ApprovalId,
  type CommandId,
  type ConversationId,
  type EventId,
  formatApprovalId,
  formatCommandId,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  type RecordId,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId,
} from "@turnturn/protocol";

export class RuntimeIds implements EngineIds {
  conversationId(): ConversationId {
    return formatConversationId(randomUUID());
  }

  sessionId(): SessionId {
    return formatSessionId(randomUUID());
  }

  turnId(): TurnId {
    return formatTurnId(randomUUID());
  }

  stepId(): StepId {
    return formatStepId(randomUUID());
  }

  toolCallId(): ToolCallId {
    return formatToolCallId(randomUUID());
  }

  approvalId(): ApprovalId {
    return formatApprovalId(randomUUID());
  }

  commandId(): CommandId {
    return formatCommandId(randomUUID());
  }

  recordId(): RecordId {
    return formatRecordId(randomUUID());
  }

  eventId(): EventId {
    return formatEventId(randomUUID());
  }
}

export class RuntimeClock implements EngineClock {
  now(): string {
    return new Date().toISOString();
  }
}
