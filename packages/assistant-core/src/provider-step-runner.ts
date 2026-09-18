import {
  type CommandEnvelope,
  type CommandTypes,
  type JsonValue,
  type StepId,
  serializeJson,
} from "@turnturn/protocol";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import {
  type ContextContribution,
  ContextContributionKinds,
  formatContextContributionId,
  type ModelContextSnapshot,
} from "./context/index.js";
import type { TurnObservation } from "./observability/types.js";
import type {
  CompletionReason,
  EngineIds,
  ProviderFailure,
  ProviderPort,
  ProviderToolCall,
  ToolExecutorPort,
} from "./ports.js";
import type { RecordEmitter } from "./records.js";

export interface ProviderStepRunnerOptions {
  readonly provider: ProviderPort;
  readonly ids: EngineIds;
  readonly records: RecordEmitter;
  readonly tools: ToolExecutorPort;
}

export interface ProviderStepResult {
  readonly stepId: StepId;
  readonly reason: CompletionReason;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly cancelled: boolean;
}

interface ProviderStepExecution {
  readonly command: CommandEnvelope<CommandTypes.TurnSubmit>;
  readonly signal: AbortSignal;
  readonly observation: TurnObservation;
}

export class ProviderStepRunner {
  constructor(private readonly options: ProviderStepRunnerOptions) {}

  async run(execution: ProviderStepExecution): Promise<ProviderStepResult> {
    const { command, signal, observation: turnObservation } = execution;
    const stepId = this.options.ids.stepId();
    await this.options.records.providerStepStarted(
      command,
      { ...command, stepId },
      providerPayload(this.options.provider.name),
    );
    const stepObservation = turnObservation.startStep({ ...command, stepId });

    let assistantText = "";
    const toolCalls: ProviderToolCall[] = [];
    let completedReason: CompletionReason | undefined;

    const request = {
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      stepId,
      history: reduceProviderHistory(this.options.records.sessionRecords(command.sessionId)),
      tools: this.options.tools.definitions(),
      signal,
    };
    stepObservation.modelContext(modelContextSnapshot(stepId, request.history, request.tools));

    for await (const event of this.options.provider.run(request, stepObservation)) {
      if (signal.aborted) break;
      switch (event.type) {
        case "text-delta":
          assistantText += event.text;
          await this.options.records.contentDelta({ ...command, stepId }, event.text);
          break;
        case "reasoning-delta":
          await this.options.records.reasoningDelta({ ...command, stepId }, event.text);
          break;
        case "tool-call-start":
        case "tool-call-arguments-delta":
        case "usage":
          break;
        case "tool-call-complete":
          toolCalls.push(event.call);
          break;
        case "completed":
          completedReason = event.reason;
          break;
        case "failed":
          await this.options.records.providerStepFailed(
            command,
            { ...command, stepId },
            providerFailureError(event.error),
          );
          stepObservation.fail(event.error);
          throw new ProviderStepFailedError(event.error);
        default:
          assertNeverProviderEvent(event);
      }
    }

    if (signal.aborted) {
      stepObservation.cancel(signal.reason === undefined ? undefined : String(signal.reason));
      return { stepId, reason: "cancelled", toolCalls, cancelled: true };
    }

    const reason = completedReason ?? (toolCalls.length > 0 ? "tool-use" : "complete");
    if (assistantText.length > 0) {
      await this.options.records.assistantMessageCompleted(command, { ...command, stepId }, assistantText);
    }
    await this.options.records.providerStepCompleted(command, { ...command, stepId }, reason);
    stepObservation.complete({ reason });

    return { stepId, reason, toolCalls, cancelled: false };
  }
}

function modelContextSnapshot(
  stepId: StepId,
  history: ReturnType<typeof reduceProviderHistory>,
  tools: ReturnType<ToolExecutorPort["definitions"]>,
): ModelContextSnapshot {
  const historyId = formatContextContributionId(`history:${stepId}`);
  const toolsId = formatContextContributionId(`tools:${stepId}`);
  const contributions: readonly ContextContribution[] = [
    {
      id: historyId,
      kind: ContextContributionKinds.ConversationHistory,
      scope: "step",
      source: { kind: "durable-provider-history" },
      content: jsonItems(history.items),
    },
    {
      id: toolsId,
      kind: ContextContributionKinds.ToolDefinitions,
      scope: "step",
      source: { kind: "tool-executor" },
      content: jsonItems(tools),
    },
  ];
  return {
    history,
    tools,
    catalog: { contributions },
    selections: [
      { contributionId: historyId, disposition: "included", order: 0 },
      { contributionId: toolsId, disposition: "included", order: 1 },
      unavailable(ContextContributionKinds.SystemInstructions, "system instructions are not wired"),
      unavailable(ContextContributionKinds.DeveloperInstructions, "developer instructions are not wired"),
      unavailable(ContextContributionKinds.WorkspaceInstructions, "workspace instructions are not wired"),
      unavailable(ContextContributionKinds.Compaction, "compaction is not implemented"),
      unavailable(ContextContributionKinds.Memory, "memory is not implemented"),
    ],
  };
}

function unavailable(kind: string, reason: string) {
  return { kind, disposition: "unavailable" as const, reason };
}

function jsonItems(value: unknown): readonly JsonValue[] {
  const parsed = JSON.parse(serializeJson(value)) as JsonValue;
  if (!Array.isArray(parsed)) throw new Error("Context contribution content must be an array");
  return parsed;
}

export class ProviderStepFailedError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
  }
}

export function providerFailureError(failure: ProviderFailure) {
  return {
    code: `PROVIDER_${failure.kind.toUpperCase().replaceAll("-", "_")}`,
    message: failure.message,
    retryable: failure.retryable,
    fatal: !failure.retryable,
    ...(failure.status === undefined ? {} : { details: { status: failure.status } }),
  };
}

function providerPayload(provider: string): { readonly provider?: string } {
  return provider ? { provider } : {};
}

function assertNeverProviderEvent(event: never): never {
  throw new Error(`Unhandled provider event: ${JSON.stringify(event)}`);
}
