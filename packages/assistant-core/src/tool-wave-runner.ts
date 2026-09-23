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
import { classifyToolCall } from "./wave-planner.js";

export interface ToolWaveRunnerOptions {
  readonly ids: EngineIds;
  readonly records: RecordEmitter;
  readonly policy: ToolPolicyPort;
  readonly tools: ToolExecutorPort;
  readonly approvals: ApprovalRegistry;
}

interface PreparedCall {
  readonly providerOrder: number;
  readonly call: ProviderToolCall;
  readonly toolCallId: ToolCallId;
  readonly scope: ToolObservationScope;
  readonly validatedInput: JsonValue;
  readonly decision: PolicyDecision;
  readonly executable: boolean; // false if deny/abort/ask resolved to not execute
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
    const toolDefs = this.options.tools.definitions();
    let currentWave: PreparedCall[] = [];
    let remainingCalls = Array.from(toolCalls);

    while (remainingCalls.length > 0 && !running.isCancelled) {
      const call = remainingCalls[0]!;
      const providerOrder = toolCalls.length - remainingCalls.length;

      // Check if this call is a barrier (not a known read-only tool)
      const classification = classifyToolCall(call, toolDefs);
      if (classification.isBarrier) {
        // Flush current wave before handling barrier
        if (currentWave.length > 0) {
          await this.executeWave(command, currentWave, running, observation);
          currentWave = [];
        }
        // Handle barrier call sequentially
        await this.executeSequentialCall(command, stepId, call, providerOrder, running, observation);
        remainingCalls = remainingCalls.slice(1);
        continue;
      }

      // Try to prepare the read-only call
      const prepared = await this.prepareCall(command, stepId, call, providerOrder, running, observation);

      // If preparation failed, flush wave and skip (prepareCall already recorded the outcome)
      if (prepared === null) {
        if (currentWave.length > 0) {
          await this.executeWave(command, currentWave, running, observation);
          currentWave = [];
        }
        remainingCalls = remainingCalls.slice(1);
        continue;
      }

      // Add to current wave
      currentWave.push(prepared);
      remainingCalls = remainingCalls.slice(1);

      // If wave is full, flush it
      if (currentWave.length === 4) {
        await this.executeWave(command, currentWave, running, observation);
        currentWave = [];
      }
    }

    // Flush any remaining wave
    if (currentWave.length > 0 && !running.isCancelled) {
      await this.executeWave(command, currentWave, running, observation);
    }

    // Handle cancelled turn: abort remaining unadmitted calls
    if (running.isCancelled && remainingCalls.length > 0) {
      for (let i = 0; i < remainingCalls.length; i++) {
        const call = remainingCalls[i]!;
        const providerOrder = toolCalls.length - remainingCalls.length + i;
        await this.recordSkippedToolAbort(
          command,
          stepId,
          call,
          providerOrder,
          running.cancelReason,
          observation,
        );
      }
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

  private async prepareCall(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: ProviderToolCall,
    providerOrder: number,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<PreparedCall | null> {
    const toolCallId = this.options.ids.toolCallId();
    const scope = toolObservationScope(command, stepId, toolCallId, call.callId);

    // Validate input
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
      return null;
    }

    // Get policy decision
    const decision = await this.options.policy.decide({
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      toolCallId,
      name: call.name,
      input: providerInput.input,
    });

    observation.observeTool({ type: "policy-decision", scope, decision });

    // Revalidate if policy modified input
    let validatedInput = providerInput.input;
    if (decision.kind === "allow-modified") {
      observation.observeTool({
        type: "validation-input",
        scope,
        phase: "policy-modified",
        name: call.name,
        input: decision.input,
      });

      const policyInput = this.options.tools.validate({ name: call.name, input: decision.input });
      observation.observeTool({ type: "validation-result", scope, phase: "policy-modified", result: policyInput });

      if (!policyInput.ok) {
        await this.recordInvalidToolInput(
          command,
          stepId,
          toolCallId,
          call,
          providerOrder,
          decision.input,
          policyInput.error,
          observation,
          scope,
        );
        return null;
      }

      validatedInput = policyInput.input;
    }

    // Handle non-executable decisions
    if (decision.kind === "deny") {
      await this.options.records.toolRequested(
        command,
        { ...command, stepId, toolCallId },
        {
          name: call.name,
          input: validatedInput,
          providerOrder,
          requiresApproval: false,
          providerToolCallId: call.callId,
        },
      );
      await this.options.records.toolDenied(command, { ...command, toolCallId }, decision.error);
      observation.observeTool({
        type: "result-recorded",
        scope,
        result: { status: "denied", error: decision.error },
      });
      return null;
    }

    if (decision.kind === "abort") {
      await this.options.records.toolRequested(
        command,
        { ...command, stepId, toolCallId },
        {
          name: call.name,
          input: validatedInput,
          providerOrder,
          requiresApproval: false,
          providerToolCallId: call.callId,
        },
      );
      await this.options.records.toolAborted(command, { ...command, toolCallId }, decision.error);
      observation.observeTool({
        type: "result-recorded",
        scope,
        result: { status: "aborted", error: decision.error },
      });
      running.requestCancel(decision.error.message);
      return null;
    }

    if (decision.kind === "ask") {
      // Approval required; cannot admit to wave
      await this.options.records.toolRequested(
        command,
        { ...command, stepId, toolCallId },
        {
          name: call.name,
          input: validatedInput,
          providerOrder,
          requiresApproval: true,
          providerToolCallId: call.callId,
        },
      );
      const approvalId = this.options.ids.approvalId();
      await this.options.records.approvalRequested(command, { ...command, toolCallId, approvalId }, decision.reason);
      const approvalScope = { ...scope, approvalId };
      observation.observeApproval({ type: "requested", scope: approvalScope, reason: decision.reason });

      const approvalDecision = await this.options.approvals.wait(
        {
          conversationId: command.conversationId,
          sessionId: command.sessionId,
          turnId: command.turnId,
          toolCallId,
          approvalId,
        },
        running.signal,
      );

      observation.observeApproval({ type: "resolved", scope: approvalScope, decision: approvalDecision });

      if (running.isCancelled) {
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
        return null;
      }

      if (approvalDecision === ApprovalDecisions.Deny) {
        const denial = syntheticError("APPROVAL_DENIED", "Approval denied");
        await this.options.records.toolDenied(command, { ...command, toolCallId }, denial);
        observation.observeTool({ type: "result-recorded", scope, result: { status: "denied", error: denial } });
        return null;
      }

      // Approval granted; proceed to execution
    }

    // Record request and prepare for execution
    await this.options.records.toolRequested(
      command,
      { ...command, stepId, toolCallId },
      {
        name: call.name,
        input: validatedInput,
        providerOrder,
        requiresApproval: decision.kind === "ask",
        providerToolCallId: call.callId,
      },
    );

    return {
      providerOrder,
      call,
      toolCallId,
      scope,
      validatedInput,
      decision,
      executable: true,
    };
  }

  private async executeWave(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    prepared: readonly PreparedCall[],
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    // Record that all calls started
    for (const p of prepared) {
      await this.options.records.toolStarted({ ...command, toolCallId: p.toolCallId }, p.call.name);
      observation.observeTool({
        type: "execution-started",
        scope: p.scope,
        name: p.call.name,
        input: p.validatedInput,
      });
    }

    // Execute all calls concurrently
    const outcomes = await Promise.all(
      prepared.map(async (p) => {
        try {
          const outcome = await this.options.tools.execute({
            conversationId: command.conversationId,
            sessionId: command.sessionId,
            turnId: command.turnId,
            toolCallId: p.toolCallId,
            name: p.call.name,
            input: p.validatedInput,
            signal: running.signal,
            callbacks: {
              stdout: (text) => {
                observation.observeTool({
                  type: "execution-output",
                  scope: p.scope,
                  stream: "stdout",
                  text,
                });
                void this.options.records.stdoutDelta({ ...command, toolCallId: p.toolCallId }, text);
              },
              stderr: (text) => {
                observation.observeTool({
                  type: "execution-output",
                  scope: p.scope,
                  stream: "stderr",
                  text,
                });
                void this.options.records.stderrDelta({ ...command, toolCallId: p.toolCallId }, text);
              },
              progress: (message) => {
                observation.observeTool({
                  type: "execution-output",
                  scope: p.scope,
                  stream: "progress",
                  text: message,
                });
                void this.options.records.toolProgress({ ...command, toolCallId: p.toolCallId }, message);
              },
            },
          });
          return { toolCallId: p.toolCallId, scope: p.scope, outcome };
        } catch (error) {
          return {
            toolCallId: p.toolCallId,
            scope: p.scope,
            outcome: {
              kind: "failed" as const,
              error: serializeThrown(error, "TOOL_EXECUTOR_THROWN"),
            },
          };
        }
      }),
    );

    // Record results in provider order
    for (const { toolCallId, scope, outcome } of outcomes) {
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
      } else {
        await this.options.records.toolFailed(command, { ...command, toolCallId }, outcome.error, cancellation);
        observation.observeTool({
          type: "result-recorded",
          scope,
          result: { status: "failed", error: outcome.error },
          ...(cancellation === undefined ? {} : { cancellation }),
        });
      }
    }
  }

  private async executeSequentialCall(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: ProviderToolCall,
    providerOrder: number,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    const prepared = await this.prepareCall(command, stepId, call, providerOrder, running, observation);
    if (prepared === null) {
      return;
    }

    // Execute single call
    await this.executeWave(command, [prepared], running, observation);
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
    observation.observeTool({
      type: "validation-input",
      scope,
      phase: "provider",
      name: call.name,
      input: call.input,
    });
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
