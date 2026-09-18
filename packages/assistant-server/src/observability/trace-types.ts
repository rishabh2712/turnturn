import type { ApprovalId, ConversationId, JsonValue, SessionId, StepId, ToolCallId, TurnId } from "@turnturn/protocol";

export const TRACE_SCHEMA_VERSION = 1;

export interface TraceManifest {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly capturedAt: string;
  readonly provider: string;
  readonly model: string;
}

export interface TraceScope {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId?: StepId;
  readonly attemptId?: string;
  readonly toolCallId?: ToolCallId;
  readonly approvalId?: ApprovalId;
}

export interface StepTraceScope extends TraceScope {
  readonly stepId: StepId;
}

export interface AttemptTraceScope extends StepTraceScope {
  readonly attemptId: string;
}

export interface ToolTraceScope extends StepTraceScope {
  readonly toolCallId: ToolCallId;
}

export interface ApprovalTraceScope extends ToolTraceScope {
  readonly approvalId: ApprovalId;
}

export type TraceEventType =
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "step.started"
  | "step.model-context"
  | "step.completed"
  | "step.failed"
  | "step.cancelled"
  | "attempt.started"
  | "attempt.wire-request"
  | "attempt.response-metadata"
  | "attempt.raw-response-frame"
  | "attempt.provider-event"
  | "attempt.completed"
  | "attempt.failed"
  | "attempt.cancelled"
  | "attempt.issue"
  | "tool.observed"
  | "approval.observed";

interface TraceEventData {
  readonly data?: JsonValue;
}

export type TraceEventDraft = TraceEventData &
  (
    | {
        readonly type: "turn.started" | "turn.completed" | "turn.failed" | "turn.cancelled";
        readonly scope: TraceScope;
      }
    | {
        readonly type: "step.started" | "step.model-context" | "step.completed" | "step.failed" | "step.cancelled";
        readonly scope: StepTraceScope;
      }
    | {
        readonly type:
          | "attempt.started"
          | "attempt.wire-request"
          | "attempt.response-metadata"
          | "attempt.raw-response-frame"
          | "attempt.provider-event"
          | "attempt.completed"
          | "attempt.failed"
          | "attempt.cancelled"
          | "attempt.issue";
        readonly scope: AttemptTraceScope;
      }
    | { readonly type: "tool.observed"; readonly scope: ToolTraceScope }
    | { readonly type: "approval.observed"; readonly scope: ApprovalTraceScope }
  );

export type TraceEnvelope = TraceEventDraft & {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly payloadRef?: string;
};

export type TraceReadIssueCode =
  | "invalid_json"
  | "invalid_manifest"
  | "invalid_envelope"
  | "sequence_gap"
  | "scope_mismatch"
  | "missing_payload"
  | "torn_tail";

export interface TraceIssue {
  readonly code: TraceReadIssueCode | "duplicate_terminal" | "missing_parent";
  readonly message: string;
  readonly line?: number;
  readonly traceSequence?: number;
}

export interface ReadTraceBundleResult {
  readonly bundlePath: string;
  readonly manifest: TraceManifest;
  readonly envelopes: readonly TraceEnvelope[];
  readonly issues: readonly TraceIssue[];
  readonly recoveredTornTail: boolean;
}

export type TraceEntityStatus = "unknown" | "running" | "completed" | "failed" | "cancelled";

export interface ReducedTraceTurn {
  readonly turnId: TurnId;
  readonly status: TraceEntityStatus;
  readonly terminalSequence?: number;
}

export interface ReducedTraceStep {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly status: TraceEntityStatus;
  readonly terminalSequence?: number;
}

export interface ReducedTraceAttempt {
  readonly attemptId: string;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly status: TraceEntityStatus;
  readonly terminalSequence?: number;
  readonly stream: readonly ReducedTraceStreamItem[];
}

export interface ReducedTraceStreamItem {
  readonly kind: "raw-response-frame" | "provider-event" | "issue";
  readonly traceSequence: number;
  readonly data?: JsonValue;
  readonly payloadRef?: string;
}

export interface ReducedTraceState {
  readonly traceId: string;
  readonly turns: readonly ReducedTraceTurn[];
  readonly steps: readonly ReducedTraceStep[];
  readonly attempts: readonly ReducedTraceAttempt[];
  readonly payloadReferences: readonly string[];
  readonly issues: readonly TraceIssue[];
}
