import { projectTrace, type TraceProjection } from "./trace-projector.js";
import type { ReducedTrace, TraceSelection, TraceSummary } from "./trace-types.js";
import type { ChatTransport } from "./transport.js";

export type TraceInspectorState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "missing"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly summary: TraceSummary;
      readonly trace: ReducedTrace;
      readonly projection: TraceProjection;
      readonly lastTraceSequence: number;
    };

export class TraceInspectorController {
  private generation = 0;
  private selection: TraceSelection | undefined;
  private state: TraceInspectorState = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly payloads = new Map<string, Promise<unknown>>();

  constructor(private readonly transport: ChatTransport) {}

  readonly getSnapshot = (): TraceInspectorState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(selection: TraceSelection): Promise<void> {
    this.selection = selection;
    this.payloads.clear();
    const generation = ++this.generation;
    this.setState({ status: "loading" });
    try {
      const { traces } = await this.transport.listTraces(
        selection.conversationId,
        selection.sessionId,
        selection.turnId,
      );
      if (generation !== this.generation) return;
      const summary = traces.at(-1);
      if (summary === undefined) {
        this.setState({ status: "missing", message: "No trace was captured for this turn." });
        return;
      }
      const detail = await this.transport.getTrace(selection.conversationId, selection.sessionId, summary.traceId);
      if (generation !== this.generation) return;
      if (detail.trace === undefined) {
        this.setState({ status: "missing", message: "The trace is no longer available." });
        return;
      }
      this.setState({
        status: "ready",
        summary,
        trace: detail.trace,
        projection: projectTrace(detail.trace),
        lastTraceSequence: detail.lastTraceSequence,
      });
    } catch (cause) {
      if (generation === this.generation) this.setState({ status: "error", message: messageOf(cause) });
    }
  }

  async refresh(): Promise<void> {
    const selection = this.selection;
    const current = this.state;
    if (selection === undefined || current.status !== "ready") return;
    const generation = this.generation;
    try {
      const detail = await this.transport.getTrace(
        selection.conversationId,
        selection.sessionId,
        current.summary.traceId,
        current.lastTraceSequence,
      );
      if (generation !== this.generation || detail.unchanged || detail.trace === undefined) return;
      this.setState({
        ...current,
        trace: detail.trace,
        projection: projectTrace(detail.trace),
        lastTraceSequence: detail.lastTraceSequence,
      });
    } catch {
      // A transient inspector failure must never disturb the conversation surface.
    }
  }

  payload(payloadId: string): Promise<unknown> {
    const selection = this.selection;
    const current = this.state;
    if (selection === undefined || current.status !== "ready") return Promise.reject(new Error("Trace is not open"));
    let request = this.payloads.get(payloadId);
    if (request === undefined) {
      request = this.transport
        .getTracePayload(selection.conversationId, selection.sessionId, current.summary.traceId, payloadId)
        .then((response) => response.value);
      this.payloads.set(payloadId, request);
    }
    return request;
  }

  close(): void {
    this.selection = undefined;
    this.generation += 1;
    this.payloads.clear();
    this.setState({ status: "idle" });
  }

  private setState(state: TraceInspectorState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
