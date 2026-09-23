import type { CommandEnvelope, CommandTypes, JsonValue, SerializedError, StepId, ToolCallId } from "@turnturn/protocol";
import type { ToolObservationScope, TurnObservation } from "./observability/types.js";
import type { EngineIds, PolicyDecision, ProviderToolCall, ToolExecutorPort, ToolPolicyPort } from "./ports.js";

export interface ToolExecutionCall {
  readonly providerOrder: number;
  readonly call: ProviderToolCall;
  readonly toolCallId: ToolCallId;
  readonly scope: ToolObservationScope;
  readonly input: JsonValue;
}

export interface InspectedCall extends ToolExecutionCall {
  readonly decision: PolicyDecision | { readonly kind: "invalid"; readonly error: SerializedError };
}

export class ToolCallInspector {
  constructor(
    private readonly ids: EngineIds,
    private readonly policy: ToolPolicyPort,
    private readonly tools: ToolExecutorPort,
  ) {}

  async inspect(
    command: CommandEnvelope<CommandTypes.TurnSubmit>,
    stepId: StepId,
    call: ProviderToolCall,
    providerOrder: number,
    observation: TurnObservation,
  ): Promise<InspectedCall> {
    const toolCallId = this.ids.toolCallId();
    const scope: ToolObservationScope = {
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      stepId,
      toolCallId,
      providerToolCallId: call.callId,
    };

    observation.observeTool({ type: "validation-input", scope, phase: "provider", name: call.name, input: call.input });
    const providerInput = this.tools.validate({ name: call.name, input: call.input });
    observation.observeTool({ type: "validation-result", scope, phase: "provider", result: providerInput });
    if (!providerInput.ok) {
      return {
        providerOrder,
        call,
        toolCallId,
        scope,
        input: call.input,
        decision: { kind: "invalid", error: providerInput.error },
      };
    }

    const decision = await this.policy.decide({
      conversationId: command.conversationId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      toolCallId,
      name: call.name,
      input: providerInput.input,
    });
    observation.observeTool({ type: "policy-decision", scope, decision });

    let input = providerInput.input;
    if (decision.kind === "allow-modified") {
      observation.observeTool({
        type: "validation-input",
        scope,
        phase: "policy-modified",
        name: call.name,
        input: decision.input,
      });
      const modified = this.tools.validate({ name: call.name, input: decision.input });
      observation.observeTool({ type: "validation-result", scope, phase: "policy-modified", result: modified });
      if (!modified.ok) {
        return {
          providerOrder,
          call,
          toolCallId,
          scope,
          input: decision.input,
          decision: { kind: "invalid", error: modified.error },
        };
      }
      input = modified.input;
    }
    return { providerOrder, call, toolCallId, scope, input, decision };
  }
}
