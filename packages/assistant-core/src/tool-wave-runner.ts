import {
  ApprovalDecisions,
  type CommandEnvelope,
  type CommandTypes,
  type JsonValue,
  type SerializedError,
  type StepId,
  type ToolCallId,
} from "@turnturn/protocol";
import type { ApprovalRegistry } from "./approval-registry.js";
import type {
  EngineIds,
  PolicyDecision,
  ProviderToolCall,
  ToolExecutorPort,
  ToolOutcome,
  ToolPolicyPort,
} from "./ports.js";
import type { RecordEmitter } from "./records.js";
import type { TurnRuntime } from "./turn-runtime.js";

export interface ToolWaveRunnerOptions {
  readonly ids: EngineIds;
  readonly records: RecordEmitter;
  readonly policy: ToolPolicyPort;
  readonly tools: ToolExecutorPort;
  readonly approvals: ApprovalRegistry;
}

export class ToolWaveRunner {
  constructor(private readonly options: ToolWaveRunnerOptions) {}

  async run(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    toolCalls: readonly ProviderToolCall[],
    running: TurnRuntime,
  ): Promise<void> {
    for (const [providerOrder, call] of toolCalls.entries()) {
      if (running.isCancelled) {
        await this.recordSkippedToolAbort(command, stepId, call, providerOrder, running.cancelReason);
        continue;
      }

      const toolCallId = this.options.ids.toolCallId();
      const decision = await this.options.policy.decide({
        conversationId: command.conversationId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        toolCallId,
        name: call.name,
        input: call.input,
      });

      const input = decision.kind === "allow-modified" ? decision.input : call.input;
      const requiresApproval = decision.kind === "ask";
      await this.options.records.toolRequested(
        command,
        { ...command, stepId, toolCallId },
        {
          name: call.name,
          input,
          providerOrder,
          requiresApproval,
          providerToolCallId: call.callId,
        },
      );

      const executable = await this.resolvePolicyDecision(command, toolCallId, decision, running);
      if (!executable) continue;
      await this.executeOneTool(command, toolCallId, call.name, input, running);
    }
  }

  async abortOutstanding(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    toolCalls: readonly ProviderToolCall[],
    reason: string | undefined,
  ): Promise<void> {
    for (const [providerOrder, call] of toolCalls.entries()) {
      await this.recordSkippedToolAbort(command, stepId, call, providerOrder, reason);
    }
  }

  private async resolvePolicyDecision(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    toolCallId: ToolCallId,
    decision: PolicyDecision,
    running: TurnRuntime,
  ): Promise<boolean> {
    switch (decision.kind) {
      case "allow":
      case "allow-modified":
        return true;
      case "deny":
        await this.options.records.toolDenied(command, { ...command, toolCallId }, decision.error);
        return false;
      case "abort":
        await this.options.records.toolAborted(command, { ...command, toolCallId }, decision.error);
        running.requestCancel(decision.error.message);
        return false;
      case "ask":
        return await this.waitForApproval(command, toolCallId, decision.reason, running);
      default:
        assertNeverPolicyDecision(decision);
    }
  }

  private async waitForApproval(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    toolCallId: ToolCallId,
    reason: string,
    running: TurnRuntime,
  ): Promise<boolean> {
    const approvalId = this.options.ids.approvalId();
    await this.options.records.approvalRequested(command, { ...command, toolCallId, approvalId }, reason);
    const decision = await this.options.approvals.wait(
      {
        conversationId: command.conversationId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        toolCallId,
        approvalId,
      },
      running.signal,
    );

    if (running.isCancelled) {
      await this.options.records.toolAborted(
        command,
        { ...command, toolCallId },
        syntheticError("TURN_CANCELLED", running.cancelReason ?? "Turn cancelled"),
      );
      return false;
    }
    if (decision === ApprovalDecisions.Allow) return true;

    await this.options.records.toolDenied(
      command,
      { ...command, toolCallId },
      syntheticError("APPROVAL_DENIED", "Approval denied"),
    );
    return false;
  }

  private async executeOneTool(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    toolCallId: ToolCallId,
    name: string,
    input: JsonValue,
    running: TurnRuntime,
  ): Promise<void> {
    await this.options.records.toolStarted({ ...command, toolCallId }, name);
    let outcome: ToolOutcome;
    try {
      outcome = await this.options.tools.execute({
        conversationId: command.conversationId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        toolCallId,
        name,
        input,
        signal: running.signal,
        callbacks: {
          stdout: (text) => void this.options.records.stdoutDelta({ ...command, toolCallId }, text),
          stderr: (text) => void this.options.records.stderrDelta({ ...command, toolCallId }, text),
          progress: (message) => void this.options.records.toolProgress({ ...command, toolCallId }, message),
        },
      });
    } catch (error) {
      outcome = { kind: "failed", error: serializeThrown(error, "TOOL_EXECUTOR_THROWN") };
    }

    if (running.isCancelled) {
      await this.options.records.toolAborted(
        command,
        { ...command, toolCallId },
        syntheticError("TURN_CANCELLED", "Turn cancelled"),
      );
      return;
    }

    if (outcome.kind === "completed") {
      await this.options.records.toolCompleted(command, { ...command, toolCallId }, outcome.output);
      return;
    }

    await this.options.records.toolFailed(command, { ...command, toolCallId }, outcome.error);
  }

  private async recordSkippedToolAbort(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: ProviderToolCall,
    providerOrder: number,
    reason: string | undefined,
  ): Promise<void> {
    const toolCallId = this.options.ids.toolCallId();
    await this.options.records.toolRequested(
      command,
      { ...command, stepId, toolCallId },
      {
        name: call.name,
        input: call.input,
        providerOrder,
        requiresApproval: false,
        providerToolCallId: call.callId,
      },
    );
    await this.options.records.toolAborted(
      command,
      { ...command, toolCallId },
      syntheticError("TURN_CANCELLED", reason ?? "Turn cancelled"),
    );
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
  return { code, message, retryable: false, fatal: false };
}

function assertNeverPolicyDecision(decision: never): never {
  throw new Error(`Unhandled policy decision: ${JSON.stringify(decision)}`);
}
