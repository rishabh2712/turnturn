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
import type { ToolObservationScope, TurnObservation } from "./observability/types.js";
import type {
  EngineIds,
  PolicyDecision,
  ProviderToolCall,
  ToolExecutorPort,
  ToolInputValidation,
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
    observation: TurnObservation,
  ): Promise<void> {
    for (const [providerOrder, call] of toolCalls.entries()) {
      if (running.isCancelled) {
        await this.recordSkippedToolAbort(command, stepId, call, providerOrder, running.cancelReason, observation);
        continue;
      }

      const toolCallId = this.options.ids.toolCallId();
      const scope = toolObservationScope(command, stepId, toolCallId, call.callId);
      observation.observeTool({
        type: "validation-input",
        scope,
        phase: "provider",
        name: call.name,
        input: call.input,
      });
      const providerInput = this.options.tools.validate({ name: call.name, input: call.input });
      observation.observeTool({ type: "validation-result", scope, phase: "provider", result: providerInput });
      if (!providerInput.ok) {
        await this.recordInvalidToolInput(
          command,
          stepId,
          toolCallId,
          call,
          providerOrder,
          call.input,
          providerInput.error,
          observation,
          scope,
        );
        continue;
      }

      const decision = await this.options.policy.decide({
        conversationId: command.conversationId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        toolCallId,
        name: call.name,
        input: providerInput.input,
      });
      observation.observeTool({ type: "policy-decision", scope, decision });

      let policyInput: ToolInputValidation = providerInput;
      if (decision.kind === "allow-modified") {
        observation.observeTool({
          type: "validation-input",
          scope,
          phase: "policy-modified",
          name: call.name,
          input: decision.input,
        });
        policyInput = this.options.tools.validate({ name: call.name, input: decision.input });
        observation.observeTool({ type: "validation-result", scope, phase: "policy-modified", result: policyInput });
      }
      if (!policyInput.ok) {
        await this.recordInvalidToolInput(
          command,
          stepId,
          toolCallId,
          call,
          providerOrder,
          decision.kind === "allow-modified" ? decision.input : call.input,
          policyInput.error,
          observation,
          scope,
        );
        continue;
      }

      const input = policyInput.input;
      await this.options.records.toolRequested(
        command,
        { ...command, stepId, toolCallId },
        {
          name: call.name,
          input,
          providerOrder,
          requiresApproval: decision.kind === "ask",
          providerToolCallId: call.callId,
        },
      );

      const executable = await this.resolvePolicyDecision(command, scope, decision, running, observation);
      if (!executable) continue;
      await this.executeOneTool(command, scope, call.name, input, running, observation);
    }
  }

  async abortOutstanding(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    toolCalls: readonly ProviderToolCall[],
    reason: string | undefined,
    observation: TurnObservation,
  ): Promise<void> {
    for (const [providerOrder, call] of toolCalls.entries()) {
      await this.recordSkippedToolAbort(command, stepId, call, providerOrder, reason, observation);
    }
  }

  private async recordInvalidToolInput(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    toolCallId: ToolCallId,
    call: ProviderToolCall,
    providerOrder: number,
    input: JsonValue,
    error: SerializedError,
    observation: TurnObservation,
    scope: ToolObservationScope,
  ): Promise<void> {
    await this.options.records.toolRequested(
      command,
      { ...command, stepId, toolCallId },
      {
        name: call.name,
        input,
        providerOrder,
        requiresApproval: false,
        providerToolCallId: call.callId,
      },
    );
    await this.options.records.toolFailed(command, { ...command, toolCallId }, error);
    observation.observeTool({ type: "result-recorded", scope, result: { status: "failed", error } });
  }

  private async resolvePolicyDecision(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    scope: ToolObservationScope,
    decision: PolicyDecision,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<boolean> {
    const toolCallId = scope.toolCallId;
    switch (decision.kind) {
      case "allow":
      case "allow-modified":
        return true;
      case "deny":
        await this.options.records.toolDenied(command, { ...command, toolCallId }, decision.error);
        observation.observeTool({
          type: "result-recorded",
          scope,
          result: { status: "denied", error: decision.error },
        });
        return false;
      case "abort":
        await this.options.records.toolAborted(command, { ...command, toolCallId }, decision.error);
        observation.observeTool({
          type: "result-recorded",
          scope,
          result: { status: "aborted", error: decision.error },
        });
        running.requestCancel(decision.error.message);
        return false;
      case "ask":
        return await this.waitForApproval(command, scope, decision.reason, running, observation);
      default:
        assertNeverPolicyDecision(decision);
    }
  }

  private async waitForApproval(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    scope: ToolObservationScope,
    reason: string,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<boolean> {
    const toolCallId = scope.toolCallId;
    const approvalId = this.options.ids.approvalId();
    await this.options.records.approvalRequested(command, { ...command, toolCallId, approvalId }, reason);
    const approvalScope = { ...scope, approvalId };
    observation.observeApproval({ type: "requested", scope: approvalScope, reason });
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
      observation.observeApproval({
        type: "cancelled",
        scope: approvalScope,
        ...(running.cancelReason === undefined ? {} : { reason: running.cancelReason }),
      });
      await this.options.records.toolAborted(
        command,
        { ...command, toolCallId },
        syntheticError("TURN_CANCELLED", running.cancelReason ?? "Turn cancelled"),
      );
      observation.observeTool({
        type: "result-recorded",
        scope,
        result: {
          status: "aborted",
          error: syntheticError("TURN_CANCELLED", running.cancelReason ?? "Turn cancelled"),
        },
      });
      return false;
    }
    observation.observeApproval({ type: "resolved", scope: approvalScope, decision });
    if (decision === ApprovalDecisions.Allow) return true;

    const denial = syntheticError("APPROVAL_DENIED", "Approval denied");
    await this.options.records.toolDenied(command, { ...command, toolCallId }, denial);
    observation.observeTool({ type: "result-recorded", scope, result: { status: "denied", error: denial } });
    return false;
  }

  private async executeOneTool(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    scope: ToolObservationScope,
    name: string,
    input: JsonValue,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    const toolCallId = scope.toolCallId;
    await this.options.records.toolStarted({ ...command, toolCallId }, name);
    observation.observeTool({ type: "execution-started", scope, name, input });
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
          stdout: (text) => {
            observation.observeTool({ type: "execution-output", scope, stream: "stdout", text });
            void this.options.records.stdoutDelta({ ...command, toolCallId }, text);
          },
          stderr: (text) => {
            observation.observeTool({ type: "execution-output", scope, stream: "stderr", text });
            void this.options.records.stderrDelta({ ...command, toolCallId }, text);
          },
          progress: (message) => {
            observation.observeTool({ type: "execution-output", scope, stream: "progress", text: message });
            void this.options.records.toolProgress({ ...command, toolCallId }, message);
          },
        },
      });
    } catch (error) {
      outcome = { kind: "failed", error: serializeThrown(error, "TOOL_EXECUTOR_THROWN") };
    }
    observation.observeTool({ type: "execution-finished", scope, outcome });

    const cancellation = running.isCancelled ? cancellationMetadata(running.cancelReason) : undefined;

    if (outcome.kind === "completed") {
      await this.options.records.toolCompleted(command, { ...command, toolCallId }, outcome.output, cancellation);
      observation.observeTool({
        type: "result-recorded",
        scope,
        result: { status: "completed", output: outcome.output },
        ...(cancellation === undefined ? {} : { cancellation }),
      });
      return;
    }

    await this.options.records.toolFailed(command, { ...command, toolCallId }, outcome.error, cancellation);
    observation.observeTool({
      type: "result-recorded",
      scope,
      result: { status: "failed", error: outcome.error },
      ...(cancellation === undefined ? {} : { cancellation }),
    });
  }

  private async recordSkippedToolAbort(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: ProviderToolCall,
    providerOrder: number,
    reason: string | undefined,
    observation: TurnObservation,
  ): Promise<void> {
    const toolCallId = this.options.ids.toolCallId();
    const scope = toolObservationScope(command, stepId, toolCallId, call.callId);
    observation.observeTool({ type: "validation-input", scope, phase: "provider", name: call.name, input: call.input });
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
    const error = syntheticError("TURN_CANCELLED", reason ?? "Turn cancelled");
    await this.options.records.toolAborted(command, { ...command, toolCallId }, error);
    observation.observeTool({ type: "result-recorded", scope, result: { status: "aborted", error } });
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

function cancellationMetadata(reason: string | undefined): { readonly requested: true; readonly reason?: string } {
  return reason === undefined ? { requested: true } : { requested: true, reason };
}

function toolObservationScope(
  command: CommandEnvelope<CommandTypes.TurnSubmit>,
  stepId: StepId,
  toolCallId: ToolCallId,
  providerToolCallId: string,
): ToolObservationScope {
  return {
    conversationId: command.conversationId,
    sessionId: command.sessionId,
    turnId: command.turnId,
    stepId,
    toolCallId,
    providerToolCallId,
  };
}

function assertNeverPolicyDecision(decision: never): never {
  throw new Error(`Unhandled policy decision: ${JSON.stringify(decision)}`);
}
