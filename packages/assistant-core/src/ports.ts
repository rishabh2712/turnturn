import type {
  ApprovalDecisions,
  ApprovalId,
  CommandEnvelope,
  ConversationId,
  DurableRecord,
  DurableRecordDraft,
  EventId,
  JsonValue,
  LiveEvent,
  RecordId,
  SerializedError,
  SessionId,
  StepId,
  ToolCallId,
  TurnId,
} from "@turnturn/protocol";
import type { ProviderHistory } from "@turnturn/protocol/provider-history";
import type { StepObservation } from "./observability/types.js";

export type CompletionReason = "complete" | "tool-use" | "output-limit" | "refused" | "cancelled";

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderFailure {
  readonly kind: "transport" | "request-rejected" | "protocol" | "interrupted" | "context-limit";
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface ProviderToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call-start"; readonly callId: string; readonly name: string }
  | { readonly type: "tool-call-arguments-delta"; readonly callId: string; readonly text: string }
  | { readonly type: "tool-call-complete"; readonly call: ProviderToolCall }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | { readonly type: "completed"; readonly reason: CompletionReason; readonly usage?: ProviderUsage }
  | { readonly type: "failed"; readonly error: ProviderFailure };

export interface ProviderRequest {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly history: ProviderHistory;
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
}

export interface ProviderPort {
  readonly name: string;
  run(request: ProviderRequest, observation?: StepObservation): AsyncIterable<ProviderEvent>;
}

export type ToolOutcome =
  | { readonly kind: "completed"; readonly output: JsonValue }
  | { readonly kind: "failed"; readonly error: SerializedError };

export interface ToolExecutionCallbacks {
  stdout(text: string): void;
  stderr(text: string): void;
  progress(message: string): void;
}

export interface ToolExecutionRequest {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  readonly callbacks: ToolExecutionCallbacks;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  readonly mutating: boolean;
}

export type ToolInputValidation =
  | { readonly ok: true; readonly input: JsonValue }
  | { readonly ok: false; readonly error: SerializedError };

export interface ToolValidationRequest {
  readonly name: string;
  readonly input: JsonValue;
}

export interface ToolExecutorPort {
  definitions(): readonly ToolDefinition[];
  validate(request: ToolValidationRequest): ToolInputValidation;

  /**
   * Tool-level failures, such as a missing file or a non-runnable command, are returned as
   * `{ kind: "failed" }`. Throwing means the executor implementation itself is broken and the
   * engine should fail the turn.
   */
  execute(request: ToolExecutionRequest): Promise<ToolOutcome>;
}

export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "allow-modified"; readonly input: JsonValue }
  | { readonly kind: "deny"; readonly error: SerializedError }
  | { readonly kind: "ask"; readonly reason: string }
  | { readonly kind: "abort"; readonly error: SerializedError };

export interface PolicyRequest {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
}

export interface ToolPolicyPort {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface DurableSink {
  append(draft: DurableRecordDraft): Promise<DurableRecord>;
  records(): readonly DurableRecord[];
}

export interface LiveSink {
  publish(event: LiveEvent): void;
}

export interface EngineIds {
  conversationId(): ConversationId;
  sessionId(): SessionId;
  turnId(): TurnId;
  stepId(): StepId;
  toolCallId(): ToolCallId;
  approvalId(): ApprovalId;
  commandId(): import("@turnturn/protocol").CommandId;
  recordId(): RecordId;
  eventId(): EventId;
}

export interface EngineClock {
  now(): string;
}

export type CommandOutcome =
  | { readonly kind: "accepted"; readonly records: readonly DurableRecord[] }
  | { readonly kind: "duplicate"; readonly records: readonly DurableRecord[] }
  | { readonly kind: "rejected"; readonly code: string; readonly message: string };

export interface AssistantEngine {
  submit(command: CommandEnvelope): Promise<CommandOutcome>;
  state(): import("@turnturn/protocol/engine-state").EngineState;
}

export type ApprovalResolution = ApprovalDecisions;
