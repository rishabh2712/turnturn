import type { CommandEnvelope, CommandTypes, SerializedError, TurnId } from "@turnturn/protocol";
import type { ApprovalRegistry } from "./approval-registry.js";
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
    const running = this.start(command);

    try {
      await this.writeUserTurnStart(command);
      await this.runProviderToolLoop(command, running);
      await this.ensureTerminalAfterLoop(command, running);
    } catch (error) {
      await this.failOrAbort(command, running, error);
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

  private start(command: CommandEnvelope<CommandTypes.TurnSubmit>): TurnRuntime {
    const running = new TurnRuntime({
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
    });
    this.runningTurns.set(command.turnId, running);
    return running;
  }

  private async writeUserTurnStart(command: CommandEnvelope<CommandTypes.TurnSubmit>): Promise<void> {
    await this.options.records.turnStarted(command, command, command.payload.input);
    await this.options.records.userInputAccepted(command, command, command.payload.input);
  }

  private async runProviderToolLoop(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
  ): Promise<void> {
    while (!running.isCancelled) {
      const step = await this.providerSteps.run(command, running.signal);

      if (step.cancelled) {
        await this.abortCancelledProviderStep(command, running, step);
        return;
      }

      if (step.toolCalls.length > 0) {
        await this.toolWaves.run(command, step.stepId, step.toolCalls, running);
        continue;
      }

      if (running.isCancelled) return;
      await this.completeTurn(command, running, step.reason);
      return;
    }
  }

  private async abortCancelledProviderStep(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
    step: Awaited<ReturnType<ProviderStepRunner["run"]>>,
  ): Promise<void> {
    await this.toolWaves.abortOutstanding(command, step.stepId, step.toolCalls, running.cancelReason);
    await this.options.records.providerStepCompleted(command, { ...command, stepId: step.stepId }, "cancelled");
  }

  private async ensureTerminalAfterLoop(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
  ): Promise<void> {
    if (running.isTerminal) return;

    if (running.isCancelled) {
      await this.abortTurn(command, running, running.cancelReason);
      return;
    }

    await this.failTurn(
      command,
      running,
      syntheticError("TURN_LOOP_EXITED_WITHOUT_TERMINAL", "Turn loop exited without a terminal condition"),
    );
  }

  private async failOrAbort(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
    error: unknown,
  ): Promise<void> {
    if (running.isCancelled) {
      await this.abortTurn(command, running, running.cancelReason);
      return;
    }

    await this.failTurn(command, running, serializeThrown(error, "ENGINE_ERROR"));
  }

  private async completeTurn(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
    stopReason: string,
  ): Promise<void> {
    await this.options.records.turnCompleted(command, command, stopReason);
    running.markTerminal();
  }

  private async abortTurn(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
    reason: string | undefined,
  ): Promise<void> {
    if (running.isTerminal) return;
    await this.options.records.turnAborted(command, command, reason);
    running.markTerminal();
  }

  private async failTurn(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    running: TurnRuntime,
    error: SerializedError,
  ): Promise<void> {
    await this.options.records.turnFailed(command, command, error);
    running.markTerminal();
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
