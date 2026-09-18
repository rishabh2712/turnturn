import type { ConversationId, JsonValue, SessionId, TurnId } from "@turnturn/protocol";

export type TraceEntityStatus = "unknown" | "running" | "completed" | "failed" | "cancelled";

export interface TraceSummary {
  readonly traceId: string;
  readonly turnId: TurnId;
  readonly capturedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly status: TraceEntityStatus;
  readonly lastTraceSequence: number;
  readonly issueCount: number;
}

export interface TraceListResponse {
  readonly traces: readonly TraceSummary[];
}

export interface TraceObservation {
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly type: string;
  readonly data?: JsonValue;
}

export interface TraceStreamItem {
  readonly kind: "raw-response-frame" | "provider-event" | "issue";
  readonly traceSequence: number;
  readonly observedAt: string;
  readonly data?: JsonValue;
  readonly payloadRef?: string;
}

export interface TraceContextProjection {
  readonly messages: readonly JsonValue[];
  readonly contributions: readonly JsonValue[];
  readonly selections: readonly JsonValue[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly mutating: boolean }[];
  readonly estimatedTokens: number;
}

export interface ReducedTrace {
  readonly traceId: string;
  readonly turns: readonly {
    readonly turnId: TurnId;
    readonly status: TraceEntityStatus;
    readonly terminalSequence?: number;
    readonly startedAt?: string;
    readonly terminalAt?: string;
  }[];
  readonly steps: readonly {
    readonly stepId: string;
    readonly turnId: TurnId;
    readonly status: TraceEntityStatus;
    readonly terminalSequence?: number;
    readonly startedAt?: string;
    readonly terminalAt?: string;
    readonly context?: TraceContextProjection;
    readonly contextPayloadRef?: string;
  }[];
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly stepId: string;
    readonly turnId: TurnId;
    readonly status: TraceEntityStatus;
    readonly terminalSequence?: number;
    readonly startedAt?: string;
    readonly terminalAt?: string;
    readonly started?: TraceObservation;
    readonly request?: TraceObservation & { readonly payloadRef?: string };
    readonly responseMetadata?: TraceObservation;
    readonly stream: readonly TraceStreamItem[];
    readonly completion?: JsonValue;
  }[];
  readonly tools: readonly {
    readonly toolCallId: string;
    readonly stepId: string;
    readonly providerToolCallId?: string;
    readonly observations: readonly TraceObservation[];
  }[];
  readonly approvals: readonly {
    readonly approvalId: string;
    readonly toolCallId: string;
    readonly stepId: string;
    readonly observations: readonly TraceObservation[];
  }[];
  readonly provenanceLinks: readonly JsonValue[];
  readonly payloadReferences: readonly string[];
  readonly issues: readonly JsonValue[];
}

export interface TraceDetailResponse {
  readonly traceId: string;
  readonly lastTraceSequence: number;
  readonly unchanged: boolean;
  readonly trace?: ReducedTrace;
}

export interface TracePayloadResponse {
  readonly payloadId: string;
  readonly value: JsonValue;
}

export interface TraceSelection {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}
