import type { ModelContextProjection } from "@turnturn/assistant-core/context";
import type { ProviderAttemptCompletion } from "@turnturn/assistant-core/observability";
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
  readonly providerToolCallId?: string;
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
  readonly startedAt?: string;
  readonly terminalAt?: string;
}

export interface ReducedTraceStep {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly status: TraceEntityStatus;
  readonly terminalSequence?: number;
  readonly startedAt?: string;
  readonly terminalAt?: string;
  readonly context?: ModelContextProjection;
  readonly contextPayloadRef?: string;
}

export interface ReducedTraceRequest {
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly data?: JsonValue;
  readonly payloadRef?: string;
}

export interface ReducedTraceAttempt {
  readonly attemptId: string;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly status: TraceEntityStatus;
  readonly terminalSequence?: number;
  readonly startedAt?: string;
  readonly terminalAt?: string;
  readonly stream: readonly ReducedTraceStreamItem[];
  readonly started?: ReducedTraceObservation;
  readonly request?: ReducedTraceRequest;
  readonly responseMetadata?: ReducedTraceObservation;
  /** Provider-reported usage in this completion remains authoritative over local estimates. */
  readonly completion?: ProviderAttemptCompletion;
}

export interface ReducedTraceObservation {
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly type: string;
  readonly data?: JsonValue;
}

export interface ReducedTraceTool {
  readonly toolCallId: ToolCallId;
  readonly stepId: StepId;
  readonly providerToolCallId?: string;
  readonly observations: readonly ReducedTraceObservation[];
}

export interface ReducedTraceApproval {
  readonly approvalId: ApprovalId;
  readonly toolCallId: ToolCallId;
  readonly stepId: StepId;
  readonly observations: readonly ReducedTraceObservation[];
}

export type ReducedTraceProvenanceLink =
  | {
      readonly type: "attempt-produced-tool-call";
      readonly attemptId: string;
      readonly toolCallId: ToolCallId;
      readonly providerToolCallId: string;
    }
  | {
      readonly type: "tool-produced-result";
      readonly toolCallId: ToolCallId;
      readonly traceSequence: number;
    }
  | {
      readonly type: "request-included-tool-call" | "request-included-tool-result";
      readonly attemptId: string;
      readonly toolCallId: ToolCallId;
      readonly recordId: string;
    };

export interface ReducedTraceStreamItem {
  readonly kind: "raw-response-frame" | "provider-event" | "issue";
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly data?: JsonValue;
  readonly payloadRef?: string;
}

export interface ReducedTraceState {
  readonly traceId: string;
  readonly turns: readonly ReducedTraceTurn[];
  readonly steps: readonly ReducedTraceStep[];
  readonly attempts: readonly ReducedTraceAttempt[];
  readonly tools: readonly ReducedTraceTool[];
  readonly approvals: readonly ReducedTraceApproval[];
  readonly provenanceLinks: readonly ReducedTraceProvenanceLink[];
  readonly payloadReferences: readonly string[];
  readonly issues: readonly TraceIssue[];
}
