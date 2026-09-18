import type { ModelContextProjection } from "@turnturn/assistant-core/context";
import type { ProviderAttemptCompletion } from "@turnturn/assistant-core/observability";
import type { StepId, TurnId } from "@turnturn/protocol";
import type {
  ReadTraceBundleResult,
  ReducedTraceApproval,
  ReducedTraceAttempt,
  ReducedTraceObservation,
  ReducedTraceProvenanceLink,
  ReducedTraceRequest,
  ReducedTraceState,
  ReducedTraceStep,
  ReducedTraceStreamItem,
  ReducedTraceTool,
  ReducedTraceTurn,
  TraceEntityStatus,
  TraceEnvelope,
  TraceIssue,
} from "./trace-types.js";

interface MutableEntity {
  status: TraceEntityStatus;
  terminalSequence?: number;
  startedAt?: string;
  terminalAt?: string;
}

interface MutableStep extends MutableEntity {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  context?: ModelContextProjection;
  contextPayloadRef?: string;
}

interface MutableAttempt extends MutableEntity {
  readonly attemptId: string;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly stream: ReducedTraceStreamItem[];
  started?: ReducedTraceObservation;
  request?: ReducedTraceRequest;
  responseMetadata?: ReducedTraceObservation;
  completion?: ProviderAttemptCompletion;
}

interface MutableTool {
  readonly toolCallId: ReducedTraceTool["toolCallId"];
  readonly stepId: StepId;
  readonly providerToolCallId?: string;
  readonly observations: ReducedTraceObservation[];
}

interface MutableApproval {
  readonly approvalId: ReducedTraceApproval["approvalId"];
  readonly toolCallId: ReducedTraceApproval["toolCallId"];
  readonly stepId: StepId;
  readonly observations: ReducedTraceObservation[];
}

export function reduceTraceBundle(bundle: ReadTraceBundleResult): ReducedTraceState {
  const turn: MutableEntity & { readonly turnId: TurnId } = {
    turnId: bundle.manifest.turnId,
    status: "unknown",
  };
  const steps = new Map<StepId, MutableStep>();
  const attempts = new Map<string, MutableAttempt>();
  const tools = new Map<ReducedTraceTool["toolCallId"], MutableTool>();
  const approvals = new Map<ReducedTraceApproval["approvalId"], MutableApproval>();
  const payloadReferences = new Set<string>();
  const issues = [...bundle.issues];

  for (const envelope of bundle.envelopes) {
    if (envelope.payloadRef !== undefined) payloadReferences.add(envelope.payloadRef);
    if (envelope.type === "turn.started") {
      turn.status = turn.status === "unknown" ? "running" : turn.status;
      turn.startedAt = envelope.observedAt;
    }
    applyTurnTerminal(turn, envelope, issues);

    if (envelope.scope.stepId !== undefined) {
      const step = getOrCreateStep(steps, envelope, issues);
      if (envelope.type === "step.started") {
        step.status = step.status === "unknown" ? "running" : step.status;
        step.startedAt = envelope.observedAt;
      }
      if (envelope.type === "step.model-context" && envelope.data !== undefined) {
        step.context = envelope.data as unknown as ModelContextProjection;
        if (envelope.payloadRef !== undefined) step.contextPayloadRef = envelope.payloadRef;
      }
      applyStepTerminal(step, envelope, issues);
    }

    if (envelope.scope.attemptId !== undefined) {
      const attempt = getOrCreateAttempt(attempts, steps, envelope, issues);
      if (envelope.type === "attempt.started") {
        attempt.status = attempt.status === "unknown" ? "running" : attempt.status;
        attempt.startedAt = envelope.observedAt;
        attempt.started = observation(envelope);
      }
      if (envelope.type === "attempt.wire-request") {
        attempt.request = {
          traceSequence: envelope.traceSequence,
          observedAt: envelope.observedAt,
          ...(envelope.data === undefined ? {} : { data: envelope.data }),
          ...(envelope.payloadRef === undefined ? {} : { payloadRef: envelope.payloadRef }),
        };
      }
      if (envelope.type === "attempt.response-metadata") {
        attempt.responseMetadata = observation(envelope);
      }
      if (envelope.type === "attempt.completed" && envelope.data !== undefined) {
        attempt.completion = envelope.data as unknown as ProviderAttemptCompletion;
      }
      applyAttemptTerminal(attempt, envelope, issues);
      const streamItem = reduceStreamItem(envelope);
      if (streamItem !== undefined) attempt.stream.push(streamItem);
    }

    if (envelope.type === "tool.observed") observeTool(tools, envelope);
    if (envelope.type === "approval.observed") observeApproval(approvals, envelope);
  }

  const frozenTools = [...tools.values()].map(freezeTool);
  const frozenAttempts = [...attempts.values()].map(freezeAttempt);
  const frozenSteps = [...steps.values()].map(freezeStep);

  return {
    traceId: bundle.manifest.traceId,
    turns: [freezeTurn(turn)],
    steps: frozenSteps,
    attempts: frozenAttempts,
    tools: frozenTools,
    approvals: [...approvals.values()].map(freezeApproval),
    provenanceLinks: provenanceLinks(frozenSteps, frozenAttempts, frozenTools),
    payloadReferences: [...payloadReferences],
    issues,
  };
}

function observeTool(tools: Map<ReducedTraceTool["toolCallId"], MutableTool>, envelope: TraceEnvelope): void {
  const { toolCallId, stepId } = envelope.scope;
  if (toolCallId === undefined || stepId === undefined) throw new Error("Tool observation has incomplete scope");
  let tool = tools.get(toolCallId);
  if (tool === undefined) {
    tool = {
      toolCallId,
      stepId,
      ...(envelope.scope.providerToolCallId === undefined
        ? {}
        : { providerToolCallId: envelope.scope.providerToolCallId }),
      observations: [],
    };
    tools.set(toolCallId, tool);
  }
  tool.observations.push(observation(envelope));
}

function observeApproval(
  approvals: Map<ReducedTraceApproval["approvalId"], MutableApproval>,
  envelope: TraceEnvelope,
): void {
  const { approvalId, toolCallId, stepId } = envelope.scope;
  if (approvalId === undefined || toolCallId === undefined || stepId === undefined) {
    throw new Error("Approval observation has incomplete scope");
  }
  let approval = approvals.get(approvalId);
  if (approval === undefined) {
    approval = { approvalId, toolCallId, stepId, observations: [] };
    approvals.set(approvalId, approval);
  }
  approval.observations.push(observation(envelope));
}

function observation(envelope: TraceEnvelope): ReducedTraceObservation {
  const observedType = objectString(envelope.data, "type") ?? envelope.type;
  return {
    traceSequence: envelope.traceSequence,
    observedAt: envelope.observedAt,
    type: observedType,
    ...(envelope.data === undefined ? {} : { data: envelope.data }),
  };
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function getOrCreateStep(steps: Map<StepId, MutableStep>, envelope: TraceEnvelope, issues: TraceIssue[]): MutableStep {
  const stepId = envelope.scope.stepId;
  if (stepId === undefined) throw new Error("Step observation has no step scope");
  const existing = steps.get(stepId);
  if (existing !== undefined) return existing;
  if (envelope.type !== "step.started") {
    issues.push({
      code: "missing_parent",
      traceSequence: envelope.traceSequence,
      message: `Step ${stepId} was observed before step.started`,
    });
  }
  const created: MutableStep = { stepId, turnId: envelope.scope.turnId, status: "unknown" };
  steps.set(stepId, created);
  return created;
}

function getOrCreateAttempt(
  attempts: Map<string, MutableAttempt>,
  steps: Map<StepId, MutableStep>,
  envelope: TraceEnvelope,
  issues: TraceIssue[],
): MutableAttempt {
  const attemptId = envelope.scope.attemptId;
  if (attemptId === undefined) throw new Error("Attempt observation has no attempt scope");
  const existing = attempts.get(attemptId);
  if (existing !== undefined) return existing;
  if (envelope.scope.stepId === undefined) {
    throw new Error(`Attempt ${attemptId} has no step scope`);
  }
  getOrCreateStep(steps, envelope, issues);
  if (envelope.type !== "attempt.started") {
    issues.push({
      code: "missing_parent",
      traceSequence: envelope.traceSequence,
      message: `Attempt ${attemptId} was observed before attempt.started`,
    });
  }
  const created: MutableAttempt = {
    attemptId,
    stepId: envelope.scope.stepId,
    turnId: envelope.scope.turnId,
    status: "unknown",
    stream: [],
  };
  attempts.set(attemptId, created);
  return created;
}

function applyTurnTerminal(entity: MutableEntity, envelope: TraceEnvelope, issues: TraceIssue[]): void {
  const status = terminalStatus(envelope.type, "turn");
  if (status !== undefined) applyTerminal(entity, status, envelope, issues, "turn");
}

function applyStepTerminal(entity: MutableEntity, envelope: TraceEnvelope, issues: TraceIssue[]): void {
  const status = terminalStatus(envelope.type, "step");
  if (status !== undefined) applyTerminal(entity, status, envelope, issues, "step");
}

function applyAttemptTerminal(entity: MutableEntity, envelope: TraceEnvelope, issues: TraceIssue[]): void {
  const status = terminalStatus(envelope.type, "attempt");
  if (status !== undefined) applyTerminal(entity, status, envelope, issues, "attempt");
}

function terminalStatus(type: string, prefix: "turn" | "step" | "attempt"): TraceEntityStatus | undefined {
  if (type === `${prefix}.completed`) return "completed";
  if (type === `${prefix}.failed`) return "failed";
  if (type === `${prefix}.cancelled`) return "cancelled";
  return undefined;
}

function applyTerminal(
  entity: MutableEntity,
  status: TraceEntityStatus,
  envelope: TraceEnvelope,
  issues: TraceIssue[],
  label: string,
): void {
  if (entity.terminalSequence !== undefined) {
    issues.push({
      code: "duplicate_terminal",
      traceSequence: envelope.traceSequence,
      message: `${label} terminal at sequence ${entity.terminalSequence} ignored competing ${status}`,
    });
    return;
  }
  entity.status = status;
  entity.terminalSequence = envelope.traceSequence;
  entity.terminalAt = envelope.observedAt;
}

function freezeTurn(turn: MutableEntity & { readonly turnId: TurnId }): ReducedTraceTurn {
  return {
    turnId: turn.turnId,
    status: turn.status,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.terminalAt === undefined ? {} : { terminalAt: turn.terminalAt }),
    ...(turn.terminalSequence === undefined ? {} : { terminalSequence: turn.terminalSequence }),
  };
}

function freezeStep(step: MutableStep): ReducedTraceStep {
  return {
    stepId: step.stepId,
    turnId: step.turnId,
    status: step.status,
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.terminalAt === undefined ? {} : { terminalAt: step.terminalAt }),
    ...(step.context === undefined ? {} : { context: step.context }),
    ...(step.contextPayloadRef === undefined ? {} : { contextPayloadRef: step.contextPayloadRef }),
    ...(step.terminalSequence === undefined ? {} : { terminalSequence: step.terminalSequence }),
  };
}

function freezeAttempt(attempt: MutableAttempt): ReducedTraceAttempt {
  return {
    attemptId: attempt.attemptId,
    stepId: attempt.stepId,
    turnId: attempt.turnId,
    status: attempt.status,
    ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    ...(attempt.terminalAt === undefined ? {} : { terminalAt: attempt.terminalAt }),
    stream: attempt.stream,
    ...(attempt.started === undefined ? {} : { started: attempt.started }),
    ...(attempt.request === undefined ? {} : { request: attempt.request }),
    ...(attempt.responseMetadata === undefined ? {} : { responseMetadata: attempt.responseMetadata }),
    ...(attempt.completion === undefined ? {} : { completion: attempt.completion }),
    ...(attempt.terminalSequence === undefined ? {} : { terminalSequence: attempt.terminalSequence }),
  };
}

function freezeTool(tool: MutableTool): ReducedTraceTool {
  return {
    toolCallId: tool.toolCallId,
    stepId: tool.stepId,
    ...(tool.providerToolCallId === undefined ? {} : { providerToolCallId: tool.providerToolCallId }),
    observations: tool.observations,
  };
}

function freezeApproval(approval: MutableApproval): ReducedTraceApproval {
  return {
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    stepId: approval.stepId,
    observations: approval.observations,
  };
}

function provenanceLinks(
  steps: readonly ReducedTraceStep[],
  attempts: readonly ReducedTraceAttempt[],
  tools: readonly ReducedTraceTool[],
): ReducedTraceProvenanceLink[] {
  const links: ReducedTraceProvenanceLink[] = [];
  for (const tool of tools) {
    if (tool.providerToolCallId !== undefined) {
      for (const attempt of attempts.filter((candidate) => candidate.stepId === tool.stepId)) {
        if (attemptProducedCall(attempt, tool.providerToolCallId)) {
          links.push({
            type: "attempt-produced-tool-call",
            attemptId: attempt.attemptId,
            toolCallId: tool.toolCallId,
            providerToolCallId: tool.providerToolCallId,
          });
        }
      }
    }
    const result = tool.observations.find((item) => item.type === "execution-finished");
    if (result !== undefined) {
      links.push({ type: "tool-produced-result", toolCallId: tool.toolCallId, traceSequence: result.traceSequence });
    }
  }
  for (const step of steps) {
    if (step.context === undefined) continue;
    const stepAttempts = attempts.filter((attempt) => attempt.stepId === step.stepId);
    for (const message of step.context.messages) {
      if (message.toolCallId === undefined) continue;
      const type =
        message.historyType === "tool.request"
          ? "request-included-tool-call"
          : message.historyType === "tool.result"
            ? "request-included-tool-result"
            : undefined;
      if (type === undefined) continue;
      for (const attempt of stepAttempts) {
        links.push({
          type,
          attemptId: attempt.attemptId,
          toolCallId: message.toolCallId,
          recordId: message.recordId,
        });
      }
    }
  }
  return links;
}

function attemptProducedCall(attempt: ReducedTraceAttempt, providerToolCallId: string): boolean {
  return attempt.stream.some((item) => {
    if (item.kind !== "provider-event" || item.data === undefined) return false;
    if (objectString(item.data, "type") !== "tool-call-complete") return false;
    const call = (item.data as Record<string, unknown>).call;
    return objectString(call, "callId") === providerToolCallId;
  });
}

function reduceStreamItem(envelope: TraceEnvelope): ReducedTraceStreamItem | undefined {
  const kind =
    envelope.type === "attempt.raw-response-frame"
      ? "raw-response-frame"
      : envelope.type === "attempt.provider-event"
        ? "provider-event"
        : envelope.type === "attempt.issue"
          ? "issue"
          : undefined;
  if (kind === undefined) return undefined;
  return {
    kind,
    traceSequence: envelope.traceSequence,
    observedAt: envelope.observedAt,
    ...(envelope.data === undefined ? {} : { data: envelope.data }),
    ...(envelope.payloadRef === undefined ? {} : { payloadRef: envelope.payloadRef }),
  };
}
