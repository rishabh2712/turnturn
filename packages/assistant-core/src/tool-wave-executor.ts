import type { CommandEnvelope, CommandTypes, SerializedError } from "@turnturn/protocol";
import type { TurnObservation } from "./observability/types.js";
import type { ToolExecutorPort } from "./ports.js";
import type { RecordEmitter } from "./records.js";
import type { ToolExecutionCall } from "./tool-call-inspector.js";
import type { TurnRuntime } from "./turn-runtime.js";

export class ToolWaveExecutor {
  constructor(
    private readonly records: RecordEmitter,
    private readonly tools: ToolExecutorPort,
  ) {}

  async abort(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    calls: readonly ToolExecutionCall[],
    error: SerializedError,
    observation: TurnObservation,
  ): Promise<void> {
    for (const call of calls) {
      await this.records.toolAborted(command, { ...command, toolCallId: call.toolCallId }, error);
      observation.observeTool({ type: "result-recorded", scope: call.scope, result: { status: "aborted", error } });
    }
  }

  async execute(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    calls: readonly ToolExecutionCall[],
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    if (running.isCancelled) {
      await this.abort(command, calls, cancellationError(running), observation);
      return;
    }

    for (const call of calls) {
      await this.records.toolStarted({ ...command, toolCallId: call.toolCallId }, call.call.name);
      observation.observeTool({
        type: "execution-started",
        scope: call.scope,
        name: call.call.name,
        input: call.input,
      });
    }

    // Execution overlaps; Promise.all preserves the admitted provider order for durable results.
    const outcomes = await Promise.all(
      calls.map(async (call) => {
        try {
          const outcome = await this.tools.execute({
            conversationId: command.conversationId,
            sessionId: command.sessionId,
            turnId: command.turnId,
            toolCallId: call.toolCallId,
            name: call.call.name,
            input: call.input,
            signal: running.signal,
            callbacks: {
              stdout: (text) => {
                observation.observeTool({ type: "execution-output", scope: call.scope, stream: "stdout", text });
                void this.records.stdoutDelta({ ...command, toolCallId: call.toolCallId }, text);
              },
              stderr: (text) => {
                observation.observeTool({ type: "execution-output", scope: call.scope, stream: "stderr", text });
                void this.records.stderrDelta({ ...command, toolCallId: call.toolCallId }, text);
              },
              progress: (message) => {
                observation.observeTool({
                  type: "execution-output",
                  scope: call.scope,
                  stream: "progress",
                  text: message,
                });
                void this.records.toolProgress({ ...command, toolCallId: call.toolCallId }, message);
              },
            },
          });
          return { call, outcome };
        } catch (error) {
          return {
            call,
            outcome: { kind: "failed" as const, error: serializeThrown(error, "TOOL_EXECUTOR_THROWN") },
          };
        }
      }),
    );

    for (const { call, outcome } of outcomes) {
      observation.observeTool({ type: "execution-finished", scope: call.scope, outcome });
      const cancellation = running.isCancelled ? cancellationMetadata(running.cancelReason) : undefined;
      if (outcome.kind === "completed") {
        await this.records.toolCompleted(
          command,
          { ...command, toolCallId: call.toolCallId },
          outcome.output,
          cancellation,
        );
        observation.observeTool({
          type: "result-recorded",
          scope: call.scope,
          result: { status: "completed", output: outcome.output },
          ...(cancellation === undefined ? {} : { cancellation }),
        });
      } else {
        await this.records.toolFailed(
          command,
          { ...command, toolCallId: call.toolCallId },
          outcome.error,
          cancellation,
        );
        observation.observeTool({
          type: "result-recorded",
          scope: call.scope,
          result: { status: "failed", error: outcome.error },
          ...(cancellation === undefined ? {} : { cancellation }),
        });
      }
    }
  }
}

export function cancellationError(running: TurnRuntime): SerializedError {
  return { code: "TURN_CANCELLED", message: running.cancelReason ?? "Turn cancelled", retryable: false, fatal: false };
}

function serializeThrown(error: unknown, code: string): SerializedError {
  return { code, message: error instanceof Error ? error.message : String(error), retryable: false, fatal: true };
}

function cancellationMetadata(reason: string | undefined): { readonly requested: true; readonly reason?: string } {
  return reason === undefined ? { requested: true } : { requested: true, reason };
}
