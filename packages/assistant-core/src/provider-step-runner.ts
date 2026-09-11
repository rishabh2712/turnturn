import type { CommandEnvelope, CommandTypes, StepId } from "@turnturn/protocol";
import type {
  CompletionReason,
  EngineIds,
  ProviderFailure,
  ProviderPort,
  ProviderToolCall,
  ToolExecutorPort,
} from "./ports.js";
import type { RecordEmitter } from "./records.js";
import { reduceSessionProviderHistory } from "./session-provider-history.js";

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

export class ProviderStepRunner {
  constructor(private readonly options: ProviderStepRunnerOptions) {}

  async run(command: CommandEnvelope<CommandTypes.TurnSubmit>, signal: AbortSignal): Promise<ProviderStepResult> {
    const stepId = this.options.ids.stepId();
    await this.options.records.providerStepStarted(
      command,
      { ...command, stepId },
      providerPayload(this.options.provider.name),
    );

    let assistantText = "";
    const toolCalls: ProviderToolCall[] = [];
    let completedReason: CompletionReason | undefined;

    const request = {
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      stepId,
      history: reduceSessionProviderHistory(this.options.records.sessionRecords(command.sessionId)),
      tools: this.options.tools.definitions(),
      signal,
    };

    for await (const event of this.options.provider.run(request)) {
      if (signal.aborted) break;
      switch (event.type) {
        case "text-delta":
          assistantText += event.text;
          await this.options.records.contentDelta(command, event.text);
          break;
        case "reasoning-delta":
          await this.options.records.reasoningDelta(command, event.text);
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
          throw new ProviderStepFailedError(event.error);
        default:
          assertNeverProviderEvent(event);
      }
    }

    if (signal.aborted) {
      return { stepId, reason: "cancelled", toolCalls, cancelled: true };
    }

    const reason = completedReason ?? (toolCalls.length > 0 ? "tool-use" : "complete");
    if (assistantText.length > 0) {
      await this.options.records.assistantMessageCompleted(command, command, assistantText);
    }
    await this.options.records.providerStepCompleted(command, { ...command, stepId }, reason);

    return { stepId, reason, toolCalls, cancelled: false };
  }
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
