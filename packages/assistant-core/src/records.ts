import {
  type ApprovalDecisions,
  type ApprovalId,
  type CancellationMetadata,
  type CommandEnvelope,
  type ConversationId,
  DurableRecordTypes as Durable,
  type DurableRecord,
  type DurableRecordDraft,
  type DurableRecordTypes,
  type JsonValue,
  LiveEventTypes as Live,
  type LiveEvent,
  type LiveEventTypes,
  SCHEMA_VERSION,
  type SerializedError,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId,
} from "@turnturn/protocol";
import type { DurableSink, EngineClock, EngineIds, LiveSink } from "./ports.js";

export interface RecordEmitterOptions {
  readonly durable: DurableSink;
  readonly live: LiveSink;
  readonly ids: EngineIds;
  readonly clock: EngineClock;
}

export interface RecordScope {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly stepId?: StepId;
  readonly toolCallId?: ToolCallId;
  readonly approvalId?: ApprovalId;
}

export class RecordEmitter {
  private appendChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RecordEmitterOptions) {}

  async conversationCreated(
    command: CommandEnvelope,
    scope: Pick<RecordScope, "conversationId" | "sessionId">,
    payload: { readonly title?: string },
  ): Promise<DurableRecord<typeof Durable.ConversationCreated>> {
    return await this.append(command, Durable.ConversationCreated, scope, payload);
  }

  async sessionCreated(
    command: CommandEnvelope,
    scope: Pick<RecordScope, "conversationId" | "sessionId">,
    payload: { readonly provider?: string },
  ): Promise<DurableRecord<typeof Durable.SessionCreated>> {
    return await this.append(command, Durable.SessionCreated, scope, payload);
  }

  async turnStarted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    input: string,
  ): Promise<DurableRecord<typeof Durable.TurnStarted>> {
    const record = await this.append(command, Durable.TurnStarted, scope, { input });
    await this.publishLive(Live.TurnStarted, scope, { input });
    return record;
  }

  async userInputAccepted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    text: string,
  ): Promise<DurableRecord<typeof Durable.UserInputAccepted>> {
    return await this.append(command, Durable.UserInputAccepted, scope, { text });
  }

  async assistantMessageCompleted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    content: string,
  ): Promise<DurableRecord<typeof Durable.AssistantMessageCompleted>> {
    return await this.append(command, Durable.AssistantMessageCompleted, scope, { content });
  }

  async providerStepStarted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "stepId">>,
    payload: { readonly provider?: string },
  ): Promise<DurableRecord<typeof Durable.ProviderStepStarted>> {
    return await this.append(command, Durable.ProviderStepStarted, scope, payload);
  }

  async providerStepCompleted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "stepId">>,
    stopReason: string,
  ): Promise<DurableRecord<typeof Durable.ProviderStepCompleted>> {
    return await this.append(command, Durable.ProviderStepCompleted, scope, { stopReason });
  }

  async providerStepFailed(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "stepId">>,
    error: SerializedError,
  ): Promise<DurableRecord<typeof Durable.ProviderStepFailed>> {
    return await this.append(command, Durable.ProviderStepFailed, scope, { error });
  }

  async toolRequested(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "stepId" | "toolCallId">>,
    payload: {
      readonly name: string;
      readonly input: JsonValue;
      readonly providerOrder: number;
      readonly requiresApproval: boolean;
      readonly providerToolCallId?: string;
    },
  ): Promise<DurableRecord<typeof Durable.ToolRequested>> {
    return await this.append(command, Durable.ToolRequested, scope, payload);
  }

  async approvalRequested(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId" | "approvalId">>,
    reason: string,
  ): Promise<DurableRecord<typeof Durable.ApprovalRequested>> {
    const record = await this.append(command, Durable.ApprovalRequested, scope, { reason });
    await this.publishLive(Live.ApprovalRequested, scope, { reason });
    return record;
  }

  async approvalResolved(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId" | "approvalId">>,
    payload: { readonly decision: ApprovalDecisions; readonly reason?: string },
  ): Promise<DurableRecord<typeof Durable.ApprovalResolved>> {
    const record = await this.append(command, Durable.ApprovalResolved, scope, payload);
    await this.publishLive(Live.ApprovalResolved, scope, { decision: payload.decision });
    return record;
  }

  async toolCompleted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId">>,
    output: JsonValue,
    cancellation?: CancellationMetadata,
  ): Promise<DurableRecord<typeof Durable.ToolResultCompleted>> {
    const record = await this.append(command, Durable.ToolResultCompleted, scope, {
      output,
      ...optionalField("cancellation", cancellation),
    });
    await this.publishLive(Live.ToolCompleted, scope, { output });
    return record;
  }

  async toolFailed(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId">>,
    error: SerializedError,
    cancellation?: CancellationMetadata,
  ): Promise<DurableRecord<typeof Durable.ToolResultFailed>> {
    const record = await this.append(command, Durable.ToolResultFailed, scope, {
      error,
      ...optionalField("cancellation", cancellation),
    });
    await this.publishLive(Live.ToolFailed, scope, { error });
    return record;
  }

  async toolDenied(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId">>,
    error: SerializedError,
  ): Promise<DurableRecord<typeof Durable.ToolResultDenied>> {
    const record = await this.append(command, Durable.ToolResultDenied, scope, { error, synthetic: true });
    await this.publishLive(Live.ToolFailed, scope, { error });
    return record;
  }

  async toolAborted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId" | "toolCallId">>,
    error: SerializedError,
  ): Promise<DurableRecord<typeof Durable.ToolResultAborted>> {
    return await this.append(command, Durable.ToolResultAborted, scope, { error, synthetic: true });
  }

  async turnCompleted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    stopReason: string,
  ): Promise<DurableRecord<typeof Durable.TurnCompleted>> {
    const record = await this.append(command, Durable.TurnCompleted, scope, { stopReason });
    await this.publishLive(Live.TurnCompleted, scope, { stopReason });
    return record;
  }

  async turnFailed(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    error: SerializedError,
  ): Promise<DurableRecord<typeof Durable.TurnFailed>> {
    const record = await this.append(command, Durable.TurnFailed, scope, { error });
    await this.publishLive(Live.TurnFailed, scope, { error });
    return record;
  }

  async turnAborted(
    command: CommandEnvelope,
    scope: Required<Pick<RecordScope, "conversationId" | "sessionId" | "turnId">>,
    reason: string | undefined,
  ): Promise<DurableRecord<typeof Durable.TurnAborted>> {
    const payload = reason === undefined ? {} : { reason };
    const record = await this.append(command, Durable.TurnAborted, scope, payload);
    await this.publishLive(Live.TurnAborted, scope, payload);
    return record;
  }

  async contentDelta(scope: Partial<RecordScope>, text: string): Promise<void> {
    await this.publishLive(Live.ContentDelta, scope, { text });
  }

  async reasoningDelta(scope: Partial<RecordScope>, text: string): Promise<void> {
    await this.publishLive(Live.ReasoningDelta, scope, { text });
  }

  async toolStarted(scope: Partial<RecordScope>, name: string): Promise<void> {
    await this.publishLive(Live.ToolStarted, scope, { name });
  }

  async stdoutDelta(scope: Partial<RecordScope>, text: string): Promise<void> {
    await this.publishLive(Live.StdoutDelta, scope, { text });
  }

  async stderrDelta(scope: Partial<RecordScope>, text: string): Promise<void> {
    await this.publishLive(Live.StderrDelta, scope, { text });
  }

  async toolProgress(scope: Partial<RecordScope>, message: string): Promise<void> {
    await this.publishLive(Live.ToolProgress, scope, { message });
  }

  private async append<T extends DurableRecordTypes>(
    command: CommandEnvelope,
    type: T,
    scope: RecordScope,
    payload: DurableRecordDraft<T>["payload"],
  ): Promise<DurableRecord<T>> {
    const draft = {
      schemaVersion: SCHEMA_VERSION,
      recordId: this.options.ids.recordId(),
      type,
      createdAt: this.options.clock.now(),
      commandId: command.commandId,
      conversationId: scope.conversationId,
      sessionId: scope.sessionId,
      ...optionalField("turnId", scope.turnId),
      ...optionalField("stepId", scope.stepId),
      ...optionalField("toolCallId", scope.toolCallId),
      ...optionalField("approvalId", scope.approvalId),
      payload,
    } as DurableRecordDraft<T>;

    let record!: DurableRecord<T>;
    this.appendChain = this.appendChain.then(async () => {
      record = (await this.options.durable.append(draft)) as DurableRecord<T>;
    });
    await this.appendChain;
    return record;
  }

  async publishLive<T extends LiveEventTypes>(
    type: T,
    scope: Partial<RecordScope>,
    payload: import("@turnturn/protocol").LivePayloads[T],
  ): Promise<void> {
    try {
      this.options.live.publish({
        schemaVersion: SCHEMA_VERSION,
        eventId: this.options.ids.eventId(),
        type,
        createdAt: this.options.clock.now(),
        ...optionalField("conversationId", scope.conversationId),
        ...optionalField("sessionId", scope.sessionId),
        ...optionalField("turnId", scope.turnId),
        ...optionalField("stepId", scope.stepId),
        ...optionalField("toolCallId", scope.toolCallId),
        ...optionalField("approvalId", scope.approvalId),
        payload,
      } as LiveEvent);
    } catch {
      // Live sinks are observational. Durable records remain the source of truth.
    }
  }
}

function optionalField<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V });
}
