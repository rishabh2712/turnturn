import {
  type ChatTransport,
  TraceInspectorController,
  type TraceInspectorState,
  type TraceSelection,
} from "@turnturn/chat-client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

type Tab = "Context" | "Request" | "Response" | "Tools" | "Runtime";
const tabs: readonly Tab[] = ["Context", "Request", "Response", "Tools", "Runtime"];

export function TurnInspector({
  transport,
  selection,
  lifecycleKey,
  onClose,
}: {
  readonly transport: ChatTransport;
  readonly selection: TraceSelection;
  readonly lifecycleKey: string;
  readonly onClose: () => void;
}) {
  const controller = useMemo(() => new TraceInspectorController(transport), [transport]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [tab, setTab] = useState<Tab>("Context");
  const [selectedAttemptId, setSelectedAttemptId] = useState<string>();

  useEffect(() => {
    void controller.open(selection);
    return () => controller.close();
  }, [controller, selection]);

  useEffect(() => {
    void controller.refresh();
  }, [controller, lifecycleKey]);

  useEffect(() => {
    const timer = window.setInterval(() => void controller.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [controller]);

  return (
    <aside aria-label="Turn trace" className="tt-inspector">
      <header className="tt-inspector-header">
        <div>
          <strong>Turn trace</strong>
          <span>{selection.turnId}</span>
        </div>
        <button aria-label="Close trace" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <nav aria-label="Trace views" className="tt-inspector-tabs">
        {tabs.map((name) => (
          <button className={tab === name ? "is-active" : ""} key={name} onClick={() => setTab(name)} type="button">
            {name}
          </button>
        ))}
      </nav>
      {state.status === "ready" && state.trace.attempts.length > 1 ? (
        <label className="tt-attempt-picker">
          Provider attempt
          <select
            onChange={(event) => setSelectedAttemptId(event.target.value)}
            value={selectedAttemptId ?? state.trace.attempts[0]?.attemptId}
          >
            {state.trace.attempts.map((attempt, index) => (
              <option key={attempt.attemptId} value={attempt.attemptId}>
                {index + 1}. {attempt.attemptId} · {attempt.status}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="tt-inspector-body">{renderState(state, tab, controller, selectedAttemptId)}</div>
    </aside>
  );
}

function renderState(
  state: TraceInspectorState,
  tab: Tab,
  controller: TraceInspectorController,
  selectedAttemptId?: string,
) {
  if (state.status === "idle" || state.status === "loading") return <p className="tt-muted">Loading trace…</p>;
  if (state.status === "missing" || state.status === "error") return <p className="tt-trace-empty">{state.message}</p>;
  if (state.status !== "ready") return null;

  const { projection } = state;
  const selectedAttempts = projection.request.filter(
    (attempt) => attempt.attemptId === (selectedAttemptId ?? projection.request[0]?.attemptId),
  );
  if (tab === "Context") {
    return (
      <div className="tt-trace-stack">
        {projection.context.map((step) => (
          <section className="tt-trace-card" key={step.stepId}>
            <TraceHeading
              title={`Step ${step.stepId}`}
              meta={`${step.context?.estimatedTokens ?? 0} estimated tokens`}
            />
            <TraceGroup label="Messages" value={step.context?.messages ?? []} />
            <TraceGroup label="Tools sent to model" value={step.context?.tools ?? []} />
            <TraceGroup label="Contributions" value={step.context?.contributions ?? []} />
            <TraceGroup label="Selections" value={step.context?.selections ?? []} />
          </section>
        ))}
      </div>
    );
  }
  if (tab === "Request") {
    return (
      <div className="tt-trace-stack">
        {selectedAttempts.map((attempt) => (
          <section className="tt-trace-card" key={attempt.attemptId}>
            <TraceHeading title={attempt.attemptId} meta={attempt.status} />
            <TraceGroup label="Attempt" value={attempt.started ?? null} />
            <TraceGroup label="Request metadata" value={attempt.request?.data ?? null} />
            {attempt.request?.payloadRef ? (
              <LazyPayload controller={controller} payloadId={attempt.request.payloadRef} title="Exact wire request" />
            ) : null}
          </section>
        ))}
      </div>
    );
  }
  if (tab === "Response") {
    return (
      <div className="tt-trace-stack">
        {selectedAttempts.map((attempt) => (
          <section className="tt-trace-card" key={attempt.attemptId}>
            <TraceHeading title={attempt.attemptId} meta={attempt.status} />
            <TraceGroup label="Response metadata" value={attempt.responseMetadata ?? null} />
            <TraceGroup label="Completion and usage" value={attempt.completion ?? null} />
            <TraceGroup
              label="Semantic stream"
              value={attempt.stream.filter((item) => item.kind !== "raw-response-frame")}
            />
            {attempt.stream
              .filter((item) => item.kind === "raw-response-frame" && item.payloadRef !== undefined)
              .map((item) => (
                <LazyPayload
                  controller={controller}
                  key={item.traceSequence}
                  payloadId={item.payloadRef as string}
                  title={`Raw frame · sequence ${item.traceSequence}`}
                />
              ))}
          </section>
        ))}
      </div>
    );
  }
  if (tab === "Tools") {
    return (
      <div className="tt-trace-stack">
        <TraceGroup label="Tool lifecycle" value={projection.tools.calls} />
        <TraceGroup label="Approvals" value={projection.tools.approvals} />
        <TraceGroup label="Provenance" value={projection.tools.provenance} />
      </div>
    );
  }
  return (
    <div className="tt-trace-stack">
      <TraceGroup label="Turns" value={projection.runtime.turns} />
      <TraceGroup label="Steps" value={projection.runtime.steps.map(stripContext)} />
      <TraceGroup label="Attempts" value={projection.runtime.attempts.map(stripStream)} />
      <TraceGroup label="Trace issues" value={projection.runtime.issues} />
    </div>
  );
}

function TraceHeading({ title, meta }: { readonly title: string; readonly meta: string }) {
  return (
    <div className="tt-trace-heading">
      <strong>{title}</strong>
      <span>{meta}</span>
    </div>
  );
}

function TraceGroup({ label, value }: { readonly label: string; readonly value: unknown }) {
  const serialized = JSON.stringify(value, null, 2);
  return (
    <details className="tt-trace-group" open>
      <summary>
        <span>{label}</span>
        <button
          aria-label={`Copy ${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void navigator.clipboard?.writeText(serialized);
          }}
          type="button"
        >
          Copy
        </button>
      </summary>
      <pre>{serialized}</pre>
    </details>
  );
}

function LazyPayload({
  controller,
  payloadId,
  title,
}: {
  readonly controller: TraceInspectorController;
  readonly payloadId: string;
  readonly title: string;
}) {
  const [value, setValue] = useState<unknown>();
  const [error, setError] = useState<string>();
  return (
    <div className="tt-trace-payload">
      <button
        disabled={value !== undefined}
        onClick={() => {
          void controller.payload(payloadId).then(setValue, (cause: unknown) => setError(String(cause)));
        }}
        type="button"
      >
        {value === undefined ? `Load ${title}` : title}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {value === undefined ? null : <pre>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

function stripContext<T extends { readonly context?: unknown }>(value: T) {
  const { context: _context, ...rest } = value;
  return rest;
}

function stripStream<T extends { readonly stream: unknown }>(value: T) {
  const { stream: _stream, ...rest } = value;
  return rest;
}
