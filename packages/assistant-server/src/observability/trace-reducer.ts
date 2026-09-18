import type { StepId, TurnId } from "@turnturn/protocol";
import type {
  ReadTraceBundleResult,
  ReducedTraceAttempt,
  ReducedTraceState,
  ReducedTraceStep,
  ReducedTraceStreamItem,
  ReducedTraceTurn,
  TraceEntityStatus,
  TraceEnvelope,
  TraceIssue,
} from "./trace-types.js";

interface MutableEntity {
  status: TraceEntityStatus;
  terminalSequence?: number;
}

interface MutableStep extends MutableEntity {
  readonly stepId: StepId;
  readonly turnId: TurnId;
}

interface MutableAttempt extends MutableEntity {
  readonly attemptId: string;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly stream: ReducedTraceStreamItem[];
}

export function reduceTraceBundle(bundle: ReadTraceBundleResult): ReducedTraceState {
  const turn: MutableEntity & { readonly turnId: TurnId } = {
    turnId: bundle.manifest.turnId,
    status: "unknown",
  };
  const steps = new Map<StepId, MutableStep>();
  const attempts = new Map<string, MutableAttempt>();
  const payloadReferences = new Set<string>();
  const issues = [...bundle.issues];

  for (const envelope of bundle.envelopes) {
    if (envelope.payloadRef !== undefined) payloadReferences.add(envelope.payloadRef);
    if (envelope.type === "turn.started") turn.status = turn.status === "unknown" ? "running" : turn.status;
    applyTurnTerminal(turn, envelope, issues);

    if (envelope.scope.stepId !== undefined) {
      const step = getOrCreateStep(steps, envelope, issues);
      if (envelope.type === "step.started") step.status = step.status === "unknown" ? "running" : step.status;
      applyStepTerminal(step, envelope, issues);
    }

    if (envelope.scope.attemptId !== undefined) {
      const attempt = getOrCreateAttempt(attempts, steps, envelope, issues);
      if (envelope.type === "attempt.started") {
        attempt.status = attempt.status === "unknown" ? "running" : attempt.status;
      }
      applyAttemptTerminal(attempt, envelope, issues);
      const streamItem = reduceStreamItem(envelope);
      if (streamItem !== undefined) attempt.stream.push(streamItem);
    }
  }

  return {
    traceId: bundle.manifest.traceId,
    turns: [freezeTurn(turn)],
    steps: [...steps.values()].map(freezeStep),
    attempts: [...attempts.values()].map(freezeAttempt),
    payloadReferences: [...payloadReferences],
    issues,
  };
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
}

function freezeTurn(turn: MutableEntity & { readonly turnId: TurnId }): ReducedTraceTurn {
  return {
    turnId: turn.turnId,
    status: turn.status,
    ...(turn.terminalSequence === undefined ? {} : { terminalSequence: turn.terminalSequence }),
  };
}

function freezeStep(step: MutableStep): ReducedTraceStep {
  return {
    stepId: step.stepId,
    turnId: step.turnId,
    status: step.status,
    ...(step.terminalSequence === undefined ? {} : { terminalSequence: step.terminalSequence }),
  };
}

function freezeAttempt(attempt: MutableAttempt): ReducedTraceAttempt {
  return {
    attemptId: attempt.attemptId,
    stepId: attempt.stepId,
    turnId: attempt.turnId,
    status: attempt.status,
    stream: attempt.stream,
    ...(attempt.terminalSequence === undefined ? {} : { terminalSequence: attempt.terminalSequence }),
  };
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
    ...(envelope.data === undefined ? {} : { data: envelope.data }),
    ...(envelope.payloadRef === undefined ? {} : { payloadRef: envelope.payloadRef }),
  };
}
