import type {
  ApprovalDecisions,
  ApprovalId,
  ConversationId,
  JsonValue,
  SerializedError,
  SessionId,
  StepId,
  ToolCallId,
  TurnId,
} from "@turnturn/protocol";
import type { ModelContextSnapshot } from "../context/index.js";
import type {
  CompletionReason,
  PolicyDecision,
  ProviderEvent,
  ProviderFailure,
  ProviderUsage,
  ToolInputValidation,
  ToolOutcome,
} from "../ports.js";

export interface TurnObservationScope {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}

export interface StepObservationScope extends TurnObservationScope {
  readonly stepId: StepId;
}

export interface ToolObservationScope extends StepObservationScope {
  readonly toolCallId: ToolCallId;
  readonly providerToolCallId?: string;
}

export interface ApprovalObservationScope extends ToolObservationScope {
  readonly approvalId: ApprovalId;
}

export interface ProviderAttemptStart {
  readonly provider: string;
  readonly model: string;
}

export interface ProviderWireRequestObservation {
  readonly method: string;
  readonly route: string;
  readonly body: JsonValue;
}

export interface ProviderResponseMetadataObservation {
  readonly status: number;
  readonly upstreamRequestId?: string;
}

export interface RawProviderFrameObservation {
  readonly data: string;
  readonly event?: string;
}

export interface ProviderAttemptCompletion {
  readonly reason: CompletionReason;
  readonly usage?: ProviderUsage;
  readonly responseId?: string;
  readonly upstreamRequestId?: string;
  readonly durationMs?: number;
}

export interface ProviderStepCompletion {
  readonly reason: CompletionReason;
}

export interface TurnCompletionObservation {
  readonly reason: string;
}

export type ObservationIssue =
  | {
      readonly kind: "duplicate-terminal";
      readonly first: ProviderAttemptTerminal;
      readonly ignored: ProviderAttemptTerminal;
    }
  | {
      readonly kind: "payload-truncated";
      readonly boundBytes: number;
    };

export type ProviderAttemptTerminal = "completed" | "failed" | "cancelled";

export interface ObservationFailure {
  readonly operation: string;
  readonly message: string;
}

export type ToolObservation =
  | {
      readonly type: "validation-input";
      readonly scope: ToolObservationScope;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "validation-result";
      readonly scope: ToolObservationScope;
      readonly result: ToolInputValidation;
    }
  | {
      readonly type: "policy-decision";
      readonly scope: ToolObservationScope;
      readonly decision: PolicyDecision;
    }
  | {
      readonly type: "execution-started";
      readonly scope: ToolObservationScope;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "execution-output";
      readonly scope: ToolObservationScope;
      readonly stream: "stdout" | "stderr" | "progress";
      readonly text: string;
    }
  | {
      readonly type: "execution-finished";
      readonly scope: ToolObservationScope;
      readonly outcome: ToolOutcome;
    };

export type ApprovalObservation =
  | {
      readonly type: "requested";
      readonly scope: ApprovalObservationScope;
      readonly reason: string;
    }
  | {
      readonly type: "resolved";
      readonly scope: ApprovalObservationScope;
      readonly decision: ApprovalDecisions;
    }
  | {
      readonly type: "cancelled";
      readonly scope: ApprovalObservationScope;
      readonly reason?: string;
    };

export interface ProviderAttemptObservation {
  wireRequest(request: ProviderWireRequestObservation): void;
  responseMetadata(metadata: ProviderResponseMetadataObservation): void;
  rawResponseFrame(frame: RawProviderFrameObservation): void;
  providerEvent(event: ProviderEvent): void;
  complete(outcome: ProviderAttemptCompletion): void;
  fail(error: ProviderFailure): void;
  cancel(reason?: string): void;
  issue(issue: ObservationIssue): void;
}

export interface StepObservation {
  modelContext(context: ModelContextSnapshot): void;
  startProviderAttempt(attempt: ProviderAttemptStart): ProviderAttemptObservation;
  complete(outcome: ProviderStepCompletion): void;
  fail(error: ProviderFailure): void;
  cancel(reason?: string): void;
}

export interface TurnObservation {
  startStep(scope: StepObservationScope): StepObservation;
  observeTool(event: ToolObservation): void;
  observeApproval(event: ApprovalObservation): void;
  complete(outcome: TurnCompletionObservation): void;
  fail(error: SerializedError): void;
  cancel(reason?: string): void;
}

export interface ObservationPort {
  startTurn(scope: TurnObservationScope): TurnObservation;
  degraded(failure: ObservationFailure): void;
}

export const noopProviderAttemptObservation: ProviderAttemptObservation = {
  wireRequest() {},
  responseMetadata() {},
  rawResponseFrame() {},
  providerEvent() {},
  complete() {},
  fail() {},
  cancel() {},
  issue() {},
};

export const noopStepObservation: StepObservation = {
  modelContext() {},
  startProviderAttempt: () => noopProviderAttemptObservation,
  complete() {},
  fail() {},
  cancel() {},
};

export const noopTurnObservation: TurnObservation = {
  startStep: () => noopStepObservation,
  observeTool() {},
  observeApproval() {},
  complete() {},
  fail() {},
  cancel() {},
};

export const noopObservation: ObservationPort = {
  startTurn: () => noopTurnObservation,
  degraded() {},
};
