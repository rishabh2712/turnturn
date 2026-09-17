import { type CommandEnvelope, CommandTypes } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { ApprovalRegistry } from "./approval-registry.js";
import { createSafeObservationPort } from "./observability/context.js";
import { noopObservation, type ObservationPort } from "./observability/types.js";
import type {
  AssistantEngine,
  CommandOutcome,
  DurableSink,
  EngineClock,
  EngineIds,
  LiveSink,
  ProviderPort,
  ToolExecutorPort,
  ToolPolicyPort,
} from "./ports.js";
import { RecordEmitter } from "./records.js";
import { commandRejected } from "./rejections.js";
import { TurnRunner } from "./turn-runner.js";

export interface AssistantEngineOptions {
  readonly provider: ProviderPort;
  readonly tools: ToolExecutorPort;
  readonly policy: ToolPolicyPort;
  readonly durable: DurableSink;
  readonly live: LiveSink;
  readonly ids: EngineIds;
  readonly clock: EngineClock;
  readonly observation?: ObservationPort;
}

type AcceptedOutcome = Extract<CommandOutcome, { readonly kind: "accepted" }>;

export function createAssistantEngine(options: AssistantEngineOptions): AssistantEngine {
  return new DefaultAssistantEngine(options);
}

class DefaultAssistantEngine implements AssistantEngine {
  private readonly completedIdempotency = new Map<
    string,
    Map<string, { type: CommandTypes; outcome: AcceptedOutcome }>
  >();
  private readonly approvals = new ApprovalRegistry();
  private readonly records: RecordEmitter;
  private readonly turns: TurnRunner;

  constructor(private readonly options: AssistantEngineOptions) {
    this.records = new RecordEmitter(options);
    const observation = createSafeObservationPort(options.observation ?? noopObservation);
    this.turns = new TurnRunner({
      approvals: this.approvals,
      ids: options.ids,
      policy: options.policy,
      provider: options.provider,
      records: this.records,
      tools: options.tools,
      observation,
    });
  }

  state() {
    return reduceEngineState(this.options.durable.records());
  }

  async submit(command: CommandEnvelope): Promise<CommandOutcome> {
    const conversationKey = command.conversationId ?? "";
    if (command.idempotencyKey) {
      const completed = this.completedIdempotency.get(conversationKey)?.get(command.idempotencyKey);
      if (completed !== undefined) {
        if (completed.type !== command.type) return commandRejected.idempotencyConflict();
        return { kind: "duplicate", records: completed.outcome.records };
      }
    }

    const before = this.options.durable.records().length;
    const outcome = await this.apply(command, before);

    if (command.idempotencyKey && outcome.kind === "accepted") {
      const conversationKeys = this.completedIdempotency.get(conversationKey) ?? new Map();
      conversationKeys.set(command.idempotencyKey, { type: command.type, outcome });
      this.completedIdempotency.set(conversationKey, conversationKeys);
    }
    return outcome;
  }

  private async apply(command: CommandEnvelope, before: number): Promise<CommandOutcome> {
    switch (command.type) {
      case CommandTypes.ConversationCreate:
        return await this.accepting(before, () => this.createConversation(command));
      case CommandTypes.SessionCreate:
        return await this.accepting(before, () => this.createSession(command));
      case CommandTypes.TurnSubmit:
        return await this.accepting(before, () => this.turns.run(command));
      case CommandTypes.ApprovalResolve:
        return await this.resolveApproval(command, before);
      case CommandTypes.TurnCancel:
        return await this.cancelTurn(command, before);
      case CommandTypes.ToolCancel:
        return commandRejected.toolCancelUnsupported();
    }
  }

  private async accepting(before: number, action: () => Promise<void>): Promise<CommandOutcome> {
    await action();
    return { kind: "accepted", records: this.options.durable.records().slice(before) };
  }

  private async createConversation(command: CommandEnvelope<CommandTypes.ConversationCreate>): Promise<void> {
    const conversationId = command.conversationId ?? this.options.ids.conversationId();
    const sessionId = command.sessionId ?? this.options.ids.sessionId();
    await this.records.conversationCreated(command, { conversationId, sessionId }, command.payload);
  }

  private async createSession(command: CommandEnvelope<CommandTypes.SessionCreate>): Promise<void> {
    const sessionId = command.sessionId ?? this.options.ids.sessionId();
    await this.records.sessionCreated(command, { conversationId: command.conversationId, sessionId }, command.payload);
  }

  private async resolveApproval(
    command: CommandEnvelope<CommandTypes.ApprovalResolve>,
    before: number,
  ): Promise<CommandOutcome> {
    const pending = this.approvals.take(command.approvalId);
    if (!pending) {
      return commandRejected.approvalNotPending();
    }
    await this.records.approvalResolved(command, pending, command.payload);
    this.approvals.complete(pending, command.payload.decision);
    return { kind: "accepted", records: this.options.durable.records().slice(before) };
  }

  private async cancelTurn(command: CommandEnvelope<CommandTypes.TurnCancel>, before: number): Promise<CommandOutcome> {
    const cancelled = await this.turns.cancel(command.turnId, command.payload.reason);
    if (!cancelled) return commandRejected.turnNotRunning();
    return { kind: "accepted", records: this.options.durable.records().slice(before) };
  }
}
