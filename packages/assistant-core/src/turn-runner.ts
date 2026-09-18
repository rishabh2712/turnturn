import type { CommandEnvelope, CommandTypes, SerializedError, TurnId } from "@turnturn/protocol";
import type { ApprovalRegistry } from "./approval-registry.js";
import type { ObservationPort, TurnObservation } from "./observability/types.js";
import type { EngineIds, ProviderPort, ToolExecutorPort, ToolPolicyPort } from "./ports.js";
import { ProviderStepRunner } from "./provider-step-runner.js";
import type { RecordEmitter } from "./records.js";
import { ToolWaveRunner } from "./tool-wave-runner.js";
import { TurnRuntime } from "./turn-runtime.js";

export interface TurnRunnerOptions {
  readonly approvals: ApprovalRegistry;
  readonly ids: EngineIds;
  readonly policy: ToolPolicyPort;
  readonly provider: ProviderPort;
  readonly records: RecordEmitter;
  readonly tools: ToolExecutorPort;
  readonly observation: ObservationPort;
}

interface TurnExecution {
  readonly command: CommandEnvelope<CommandTypes.TurnSubmit>;
  readonly runtime: TurnRuntime;
  readonly observation: TurnObservation;
}

export class TurnRunner {
  private readonly runningTurns = new Map<TurnId, TurnRuntime>();
  private readonly providerSteps: ProviderStepRunner;
  private readonly toolWaves: ToolWaveRunner;

  constructor(private readonly options: TurnRunnerOptions) {
    this.providerSteps = new ProviderStepRunner({
      provider: options.provider,
      ids: options.ids,
      records: options.records,
      tools: options.tools,
    });
    this.toolWaves = new ToolWaveRunner({
      ids: options.ids,
      records: options.records,
      policy: options.policy,
      tools: options.tools,
      approvals: options.approvals,
    });
  }

  async run(command: CommandEnvelope<CommandTypes.TurnSubmit>): Promise<void> {
    const turn = this.start(command);

    try {
      await this.writeUserTurnStart(command);
      await this.runProviderToolLoop(turn);
      await this.ensureTerminalAfterLoop(turn);
    } catch (error) {
      await this.failOrAbort(turn, error);
    } finally {
      this.runningTurns.delete(command.turnId);
    }
  }

  async cancel(turnId: TurnId, reason: string | undefined): Promise<boolean> {
    const running = this.runningTurns.get(turnId);
    if (!running) return false;

    running.requestCancel(reason);
    this.options.approvals.cancelTurn(turnId);
    await running.waitForTerminal();
    return true;
  }

  private start(command: CommandEnvelope<CommandTypes.TurnSubmit>): TurnExecution {
    const runtime = new TurnRuntime({
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
    });
    this.runningTurns.set(command.turnId, runtime);
    return {
      command,
      runtime,
      observation: this.options.observation.startTurn({
        conversationId: command.conversationId,
        sessionId: command.sessionId,
        turnId: command.turnId,
      }),
    };
  }

  private async writeUserTurnStart(command: CommandEnvelope<CommandTypes.TurnSubmit>): Promise<void> {
    await this.options.records.turnStarted(command, command, command.payload.input);
    await this.options.records.userInputAccepted(command, command, command.payload.input);
  }

  private async runProviderToolLoop(turn: TurnExecution): Promise<void> {
    while (!turn.runtime.isCancelled) {
      const step = await this.providerSteps.run({
        command: turn.command,
        signal: turn.runtime.signal,
        observation: turn.observation,
      });

      if (step.cancelled) {
        await this.abortCancelledProviderStep(turn, step);
        return;
      }

      if (step.toolCalls.length > 0) {
        await this.toolWaves.run(turn.command, step.stepId, step.toolCalls, turn.runtime, turn.observation);
        continue;
      }

      if (turn.runtime.isCancelled) return;
      await this.completeTurn(turn, step.reason);
      return;
    }
  }

  private async abortCancelledProviderStep(
    turn: TurnExecution,
    step: Awaited<ReturnType<ProviderStepRunner["run"]>>,
  ): Promise<void> {
    await this.toolWaves.abortOutstanding(
      turn.command,
      step.stepId,
      step.toolCalls,
      turn.runtime.cancelReason,
      turn.observation,
    );
    await this.options.records.providerStepCompleted(
      turn.command,
      { ...turn.command, stepId: step.stepId },
      "cancelled",
    );
  }

  private async ensureTerminalAfterLoop(turn: TurnExecution): Promise<void> {
    if (turn.runtime.isTerminal) return;

    if (turn.runtime.isCancelled) {
      await this.abortTurn(turn, turn.runtime.cancelReason);
      return;
    }

    await this.failTurn(
      turn,
      syntheticError("TURN_LOOP_EXITED_WITHOUT_TERMINAL", "Turn loop exited without a terminal condition"),
    );
  }

  private async failOrAbort(turn: TurnExecution, error: unknown): Promise<void> {
    if (turn.runtime.isCancelled) {
      await this.abortTurn(turn, turn.runtime.cancelReason);
      return;
    }

    await this.failTurn(turn, serializeThrown(error, "ENGINE_ERROR"));
  }

  private async completeTurn(turn: TurnExecution, stopReason: string): Promise<void> {
    await this.options.records.turnCompleted(turn.command, turn.command, stopReason);
    turn.runtime.markTerminal();
    turn.observation.complete({ reason: stopReason });
  }

  private async abortTurn(turn: TurnExecution, reason: string | undefined): Promise<void> {
    if (turn.runtime.isTerminal) return;
    await this.options.records.turnAborted(turn.command, turn.command, reason);
    turn.runtime.markTerminal();
    turn.observation.cancel(reason);
  }

  private async failTurn(turn: TurnExecution, error: SerializedError): Promise<void> {
    await this.options.records.turnFailed(turn.command, turn.command, error);
    turn.runtime.markTerminal();
    turn.observation.fail(error);
  }
}

function serializeThrown(error: unknown, code: string): SerializedError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    fatal: true,
  };
}

function syntheticError(code: string, message: string): SerializedError {
  return { code, message, retryable: false, fatal: true };
}
