import type { ReducedTrace } from "./trace-types.js";

export interface TraceProjection {
  readonly context: ReducedTrace["steps"];
  readonly request: ReducedTrace["attempts"];
  readonly response: ReducedTrace["attempts"];
  readonly tools: {
    readonly calls: ReducedTrace["tools"];
    readonly approvals: ReducedTrace["approvals"];
    readonly provenance: ReducedTrace["provenanceLinks"];
  };
  readonly runtime: {
    readonly turns: ReducedTrace["turns"];
    readonly steps: ReducedTrace["steps"];
    readonly attempts: ReducedTrace["attempts"];
    readonly issues: ReducedTrace["issues"];
  };
}

/** Keeps UI grouping out of React; the server remains the owner of trace reduction. */
export function projectTrace(trace: ReducedTrace): TraceProjection {
  return {
    context: trace.steps,
    request: trace.attempts,
    response: trace.attempts,
    tools: { calls: trace.tools, approvals: trace.approvals, provenance: trace.provenanceLinks },
    runtime: { turns: trace.turns, steps: trace.steps, attempts: trace.attempts, issues: trace.issues },
  };
}
