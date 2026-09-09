export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type IdPrefix = "conv" | "sess" | "turn" | "step" | "tool" | "appr" | "cmd" | "rec" | "event";
declare const idBrand: unique symbol;
export type BrandedId<P extends IdPrefix> = string & { readonly [idBrand]: P };
export type ConversationId = BrandedId<"conv">;
export type SessionId = BrandedId<"sess">;
export type TurnId = BrandedId<"turn">;
export type StepId = BrandedId<"step">;
export type ToolCallId = BrandedId<"tool">;
export type ApprovalId = BrandedId<"appr">;
export type CommandId = BrandedId<"cmd">;
export type RecordId = BrandedId<"rec">;
export type EventId = BrandedId<"event">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function formatId<P extends IdPrefix>(prefix: P, uuid: string): BrandedId<P> {
  if (!UUID.test(uuid)) throw new TypeError(`Invalid UUID for ${prefix}_ ID`);
  return `${prefix}_${uuid.toLowerCase()}` as BrandedId<P>;
}
export function parseId<P extends IdPrefix>(prefix: P, value: string): BrandedId<P> {
  const expected = `${prefix}_`;
  if (!value.startsWith(expected) || !UUID.test(value.slice(expected.length))) {
    throw new TypeError(`Invalid ${prefix}_ ID`);
  }
  return value.toLowerCase() as BrandedId<P>;
}
export const formatConversationId = (uuid: string) => formatId("conv", uuid);
export const formatSessionId = (uuid: string) => formatId("sess", uuid);
export const formatTurnId = (uuid: string) => formatId("turn", uuid);
export const formatStepId = (uuid: string) => formatId("step", uuid);
export const formatToolCallId = (uuid: string) => formatId("tool", uuid);
export const formatApprovalId = (uuid: string) => formatId("appr", uuid);
export const formatCommandId = (uuid: string) => formatId("cmd", uuid);
export const formatRecordId = (uuid: string) => formatId("rec", uuid);
export const formatEventId = (uuid: string) => formatId("event", uuid);

export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly cause?: SerializedError;
  readonly details?: JsonObject;
}

export enum CommandTypes {
  ConversationCreate = "conversation.create",
  SessionCreate = "session.create",
  TurnSubmit = "turn.submit",
  ApprovalResolve = "approval.resolve",
  TurnCancel = "turn.cancel",
  ToolCancel = "tool.cancel"
}
export enum DurableRecordTypes {
  ConversationCreated = "conversation.created",
  SessionCreated = "session.created",
  TurnStarted = "turn.started",
  UserInputAccepted = "user.input.accepted",
  AssistantMessageCompleted = "assistant.message.completed",
  ProviderStepStarted = "provider.step.started",
  ProviderStepCompleted = "provider.step.completed",
  ProviderStepFailed = "provider.step.failed",
  ToolRequested = "tool.requested",
  ApprovalRequested = "approval.requested",
  ApprovalResolved = "approval.resolved",
  ToolResultCompleted = "tool.result.completed",
  ToolResultFailed = "tool.result.failed",
  ToolResultDenied = "tool.result.denied",
  ToolResultAborted = "tool.result.aborted",
  TurnCompleted = "turn.completed",
  TurnFailed = "turn.failed",
  TurnAborted = "turn.aborted"
}
export enum LiveEventTypes {
  TurnStarted = "turn.started",
  TurnCompleted = "turn.completed",
  TurnFailed = "turn.failed",
  TurnAborted = "turn.aborted",
  ContentDelta = "content.delta",
  ReasoningDelta = "reasoning.delta",
  ProviderRaw = "provider.raw",
  Warning = "warning",
  ToolStarted = "tool.started",
  ToolProgress = "tool.progress",
  ToolCompleted = "tool.completed",
  ToolFailed = "tool.failed",
  ApprovalRequested = "approval.requested",
  ApprovalResolved = "approval.resolved",
  StdoutDelta = "stdout.delta",
  StderrDelta = "stderr.delta"
}

export enum ApprovalDecisions {
  Allow = "allow",
  Deny = "deny"
}

export interface CommandPayloads {
  [CommandTypes.ConversationCreate]: { readonly title?: string };
  [CommandTypes.SessionCreate]: { readonly provider?: string };
  [CommandTypes.TurnSubmit]: { readonly input: string };
  [CommandTypes.ApprovalResolve]: { readonly decision: ApprovalDecisions; readonly reason?: string };
  [CommandTypes.TurnCancel]: { readonly reason?: string };
  [CommandTypes.ToolCancel]: { readonly reason?: string };
}
export interface DurablePayloads {
  [DurableRecordTypes.ConversationCreated]: { readonly title?: string };
  [DurableRecordTypes.SessionCreated]: { readonly provider?: string };
  [DurableRecordTypes.TurnStarted]: { readonly input: string };
  [DurableRecordTypes.UserInputAccepted]: { readonly text: string };
  [DurableRecordTypes.AssistantMessageCompleted]: { readonly content: string };
  [DurableRecordTypes.ProviderStepStarted]: { readonly provider?: string };
  [DurableRecordTypes.ProviderStepCompleted]: { readonly stopReason?: string };
  [DurableRecordTypes.ProviderStepFailed]: { readonly error: SerializedError };
  [DurableRecordTypes.ToolRequested]: { readonly name: string; readonly input: JsonValue; readonly providerOrder: number; readonly requiresApproval: boolean; readonly providerToolCallId?: string };
  [DurableRecordTypes.ApprovalRequested]: { readonly reason: string };
  [DurableRecordTypes.ApprovalResolved]: { readonly decision: ApprovalDecisions; readonly reason?: string };
  [DurableRecordTypes.ToolResultCompleted]: { readonly output: JsonValue; readonly synthetic?: false; readonly cancellation?: CancellationMetadata };
  [DurableRecordTypes.ToolResultFailed]: { readonly error: SerializedError; readonly synthetic?: boolean; readonly cancellation?: CancellationMetadata };
  [DurableRecordTypes.ToolResultDenied]: { readonly error: SerializedError; readonly synthetic?: boolean };
  [DurableRecordTypes.ToolResultAborted]: { readonly error: SerializedError; readonly synthetic?: boolean };
  [DurableRecordTypes.TurnCompleted]: { readonly stopReason?: string };
  [DurableRecordTypes.TurnFailed]: { readonly error: SerializedError };
  [DurableRecordTypes.TurnAborted]: { readonly reason?: string };
}
export interface CancellationMetadata { readonly requested: true; readonly reason?: string }
export interface LivePayloads {
  [LiveEventTypes.TurnStarted]: { readonly input?: string };
  [LiveEventTypes.TurnCompleted]: { readonly stopReason?: string };
  [LiveEventTypes.TurnFailed]: { readonly error: SerializedError };
  [LiveEventTypes.TurnAborted]: { readonly reason?: string };
  [LiveEventTypes.ContentDelta]: { readonly text: string };
  [LiveEventTypes.ReasoningDelta]: { readonly text: string };
  [LiveEventTypes.ProviderRaw]: { readonly value: JsonValue };
  [LiveEventTypes.Warning]: { readonly message: string; readonly code?: string };
  [LiveEventTypes.ToolStarted]: { readonly name: string };
  [LiveEventTypes.ToolProgress]: { readonly message: string };
  [LiveEventTypes.ToolCompleted]: { readonly output?: JsonValue };
  [LiveEventTypes.ToolFailed]: { readonly error: SerializedError };
  [LiveEventTypes.ApprovalRequested]: { readonly reason: string };
  [LiveEventTypes.ApprovalResolved]: { readonly decision: ApprovalDecisions };
  [LiveEventTypes.StdoutDelta]: { readonly text: string };
  [LiveEventTypes.StderrDelta]: { readonly text: string };
}

interface ScopeFields {
  readonly conversationId?: ConversationId;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly stepId?: StepId;
  readonly toolCallId?: ToolCallId;
  readonly approvalId?: ApprovalId;
}
type RequiredScope<K extends keyof ScopeFields> = Required<Pick<ScopeFields, K>> & Partial<Omit<ScopeFields, K>>;
type CommandScopes<T extends CommandTypes> = T extends CommandTypes.ConversationCreate ? ScopeFields :
  T extends CommandTypes.SessionCreate ? RequiredScope<"conversationId"> :
  T extends CommandTypes.TurnSubmit | CommandTypes.TurnCancel ? RequiredScope<"conversationId" | "sessionId" | "turnId"> :
  T extends CommandTypes.ApprovalResolve ? RequiredScope<"conversationId" | "sessionId" | "turnId" | "toolCallId" | "approvalId"> :
  RequiredScope<"conversationId" | "sessionId" | "turnId" | "toolCallId">;
type DurableScopes<T extends DurableRecordTypes> = RequiredScope<"conversationId" | "sessionId"> &
  (T extends DurableRecordTypes.TurnStarted | DurableRecordTypes.UserInputAccepted | DurableRecordTypes.AssistantMessageCompleted | DurableRecordTypes.TurnCompleted | DurableRecordTypes.TurnFailed | DurableRecordTypes.TurnAborted ? Required<Pick<ScopeFields, "turnId">> :
  T extends DurableRecordTypes.ProviderStepStarted | DurableRecordTypes.ProviderStepCompleted | DurableRecordTypes.ProviderStepFailed ? Required<Pick<ScopeFields, "turnId" | "stepId">> :
  T extends DurableRecordTypes.ToolRequested ? Required<Pick<ScopeFields, "turnId" | "stepId" | "toolCallId">> :
  T extends DurableRecordTypes.ApprovalRequested | DurableRecordTypes.ApprovalResolved ? Required<Pick<ScopeFields, "turnId" | "toolCallId" | "approvalId">> :
  T extends DurableRecordTypes.ToolResultCompleted | DurableRecordTypes.ToolResultFailed | DurableRecordTypes.ToolResultDenied | DurableRecordTypes.ToolResultAborted ? Required<Pick<ScopeFields, "turnId" | "toolCallId">> : {});

type CommandEnvelopeFor<T extends CommandTypes> = CommandScopes<T> & {
  readonly schemaVersion: SchemaVersion; readonly commandId: CommandId; readonly type: T;
  readonly createdAt: string; readonly idempotencyKey?: string; readonly payload: CommandPayloads[T];
};
export type CommandEnvelope<T extends CommandTypes = CommandTypes> = T extends CommandTypes ? CommandEnvelopeFor<T> : never;
type DurableRecordDraftFor<T extends DurableRecordTypes> = DurableScopes<T> & {
  readonly schemaVersion: SchemaVersion; readonly recordId: RecordId; readonly type: T;
  readonly createdAt: string; readonly commandId?: CommandId; readonly providerRequestId?: string;
  readonly sequence?: never; readonly payload: DurablePayloads[T];
};
export type DurableRecordDraft<T extends DurableRecordTypes = DurableRecordTypes> = T extends DurableRecordTypes ? DurableRecordDraftFor<T> : never;
export type DurableRecord<T extends DurableRecordTypes = DurableRecordTypes> = T extends DurableRecordTypes ? Omit<DurableRecordDraftFor<T>, "sequence"> & { readonly sequence: number } : never;
type LiveEventFor<T extends LiveEventTypes> = ScopeFields & {
  readonly schemaVersion: SchemaVersion; readonly eventId: EventId; readonly type: T;
  readonly createdAt: string; readonly recordId?: RecordId; readonly sequence?: never;
  readonly payload: LivePayloads[T];
};
export type LiveEvent<T extends LiveEventTypes = LiveEventTypes> = T extends LiveEventTypes ? LiveEventFor<T> : never;

function assertJson(value: unknown, ancestors: Set<object>, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`Invalid JSON number at ${path}`);
    return;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new TypeError(`Invalid JSON value at ${path}`);
  }
  if (typeof value !== "object") throw new TypeError(`Invalid JSON value at ${path}`);
  if (ancestors.has(value)) throw new TypeError(`Cyclic JSON value at ${path}`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`Sparse array at ${path}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`Accessor at ${path}[${index}]`);
      assertJson(descriptor.value, ancestors, `${path}[${index}]`);
    }
    for (const key of keys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || String(Number(key)) !== key) {
        throw new TypeError(`Extra array property at ${path}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`Invalid array property at ${path}[${key}]`);
    }
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`Runtime array at ${path}`);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Runtime object at ${path}`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new TypeError(`Symbol key at ${path}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`Accessor at ${path}.${key}`);
      if (!descriptor.enumerable) throw new TypeError(`Non-enumerable property at ${path}.${key}`);
      assertJson(descriptor.value, ancestors, `${path}.${key}`);
    }
  }
  ancestors.delete(value);
}

export function serializeJson(value: unknown): string {
  assertJson(value, new Set(), "$" );
  return JSON.stringify(value)!;
}
