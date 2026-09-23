import {
  ApprovalDecisions,
  type CommandEnvelope,
  type CommandTypes,
  type SerializedError,
  type StepId,
} from "@turnturn/protocol";
import type { ApprovalRegistry } from "./approval-registry.js";
import type { TurnObservation } from "./observability/types.js";
import type { EngineIds, ProviderToolCall, ToolExecutorPort, ToolPolicyPort } from "./ports.js";
import type { RecordEmitter } from "./records.js";
import { type InspectedCall, ToolCallInspector } from "./tool-call-inspector.js";
import { cancellationError, ToolWaveExecutor } from "./tool-wave-executor.js";
import type { TurnRuntime } from "./turn-runtime.js";
import { classifyToolCall } from "./wave-planner.js";

export interface ToolWaveRunnerOptions {
  readonly ids: EngineIds;
  readonly records: RecordEmitter;
  readonly policy: ToolPolicyPort;
  readonly tools: ToolExecutorPort;
  readonly approvals: ApprovalRegistry;
}

/** Schedules calls. Inspection decides eligibility; execution owns the admitted call lifecycle. */
export class ToolWaveRunner {
  private readonly inspector: ToolCallInspector;
  private readonly executor: ToolWaveExecutor;

  constructor(private readonly options: ToolWaveRunnerOptions) {
    this.inspector = new ToolCallInspector(options.ids, options.policy, options.tools);
    this.executor = new ToolWaveExecutor(options.records, options.tools);
  }

  async run(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    toolCalls: readonly ProviderToolCall[],
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    const toolDefs = this.options.tools.definitions();
    const wave: InspectedCall[] = [];
    const drain = async (error?: SerializedError) => {
      const pending = wave.splice(0);
      if (pending.length === 0) return;
      if (error) await this.executor.abort(command, pending, error, observation);
      else await this.executor.execute(command, pending, running, observation);
    };

    for (const [providerOrder, call] of toolCalls.entries()) {
      if (running.isCancelled) break;
      const barrier = classifyToolCall(call, toolDefs).isBarrier;
      if (barrier) await drain(running.isCancelled ? cancellationError(running) : undefined);
      if (running.isCancelled) break;

      let inspected: InspectedCall;
      try {
        inspected = await this.inspector.inspect(command, stepId, call, providerOrder, observation);
      } catch (error) {
        await drain(syntheticError("TOOL_PREPARATION_ABORTED", "A later tool could not be prepared"));
        throw error;
      }
      if (running.isCancelled) break;

      if (!barrier && canJoinWave(inspected)) {
        await this.recordRequest(command, stepId, inspected);
        wave.push(inspected);
        if (wave.length === 4) await drain(running.isCancelled ? cancellationError(running) : undefined);
      } else {
        await drain(running.isCancelled ? cancellationError(running) : undefined);
        if (running.isCancelled) break;
        await this.runBarrier(command, stepId, inspected, running, observation);
      }
    }
    await drain(running.isCancelled ? cancellationError(running) : undefined);
  }

  private async recordRequest(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: InspectedCall,
  ): Promise<void> {
    await this.options.records.toolRequested(
      command,
      { ...command, stepId, toolCallId: call.toolCallId },
      {
        name: call.call.name,
        input: call.input,
        providerOrder: call.providerOrder,
        requiresApproval: call.decision.kind === "ask",
        providerToolCallId: call.call.callId,
      },
    );
  }

  private async runBarrier(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: InspectedCall,
    running: TurnRuntime,
    observation: TurnObservation,
  ): Promise<void> {
    await this.recordRequest(command, stepId, call);
    if (running.isCancelled) {
      await this.executor.abort(command, [call], cancellationError(running), observation);
      return;
    }
    const { decision, toolCallId, scope } = call;
    if (decision.kind === "invalid" || decision.kind === "deny" || decision.kind === "abort") {
      const { error } = decision;
      if (decision.kind === "invalid")
        await this.options.records.toolFailed(command, { ...command, toolCallId }, error);
      else if (decision.kind === "deny")
        await this.options.records.toolDenied(command, { ...command, toolCallId }, error);
      else await this.options.records.toolAborted(command, { ...command, toolCallId }, error);
      const status = decision.kind === "invalid" ? "failed" : decision.kind === "deny" ? "denied" : "aborted";
      observation.observeTool({ type: "result-recorded", scope, result: { status, error } });
      if (decision.kind === "abort") running.requestCancel(error.message);
      return;
    }
    if (decision.kind === "ask") {
      const approvalId = this.options.ids.approvalId();
      const approvalScope = { ...scope, approvalId };
      let pendingDecision: Promise<ApprovalDecisions> | undefined;
      await this.options.records.approvalRequested(
        command,
        { ...command, toolCallId, approvalId },
        decision.reason,
        () => {
          pendingDecision = this.options.approvals.wait(
            {
              conversationId: command.conversationId,
              sessionId: command.sessionId,
              turnId: command.turnId,
              toolCallId,
              approvalId,
            },
            running.signal,
          );
          observation.observeApproval({ type: "requested", scope: approvalScope, reason: decision.reason });
        },
      );
      if (!pendingDecision) throw new Error("Approval waiter was not registered after persistence");
      const approvalDecision = await pendingDecision;
      if (running.isCancelled) {
        observation.observeApproval({
          type: "cancelled",
          scope: approvalScope,
          ...(running.cancelReason === undefined ? {} : { reason: running.cancelReason }),
        });
        await this.executor.abort(command, [call], cancellationError(running), observation);
        return;
      }
      observation.observeApproval({ type: "resolved", scope: approvalScope, decision: approvalDecision });
      if (approvalDecision === ApprovalDecisions.Deny) {
        const error = syntheticError("APPROVAL_DENIED", "Approval denied");
        await this.options.records.toolDenied(command, { ...command, toolCallId }, error);
        observation.observeTool({ type: "result-recorded", scope, result: { status: "denied", error } });
        return;
      }
    }
    await this.executor.execute(command, [call], running, observation);
  }
}

function canJoinWave(call: InspectedCall): boolean {
  return call.decision.kind === "allow" || call.decision.kind === "allow-modified";
}

function syntheticError(code: string, message: string): SerializedError {
  return { code, message, retryable: false, fatal: false };
}
