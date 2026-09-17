# Design: Model-Turn Observability

Status: **approved for implementation, 2026-09-17.** Motivation is in `proposal.md`; normative behavior is in `specs/model-turn-observability/spec.md`; implementation order is in `tasks.md`.

**Gate tier: full.** This adds an optional observation boundary to the public engine/provider composition. It does not change `packages/protocol` or durable session records.

Design inputs: the recorded **user interview** defines the inspection problem and interaction boundary; the **neutral challenge** tests whether a custom trace and public observer are justified; the **synthesis** records the accepted dispositions. Rishabh approved the design and the resolved decisions below on 2026-09-17.

---

## Problem Statement

For any model response, an operator must be able to answer four different questions without inferring one from another:

1. What did Turnturn intend the model to see?
2. What exact provider request body did the adapter serialize?
3. What did the provider return, and how did the adapter interpret it?
4. What runtime work followed, and which results became input to a later provider attempt?

Today those facts are spread across transient local variables in `provider-step-runner.ts`, `providers/openai-chat-completions/request.ts`, the SSE parser, `tool-wave-runner.ts`, durable session records, and browser live state. The existing durable log intentionally omits provider-wire detail. The existing debug endpoint only reports reducer issues. Neither can prove whether a tool definition or result appeared in one concrete request.

## Terms

- **Turn:** one accepted `turn.submit` command through a terminal durable state.
- **Step:** one engine model phase followed by zero or more tool calls.
- **Attempt:** one concrete upstream provider request. Retry or fallback creates another attempt within the same step.
- **Semantic context:** the provider-neutral history, tool definitions, and named context contributions that Turnturn intended to send.
- **Wire request:** the exact JSON body passed to `fetch`, excluding transport credentials and other request headers.
- **Raw response evidence:** ordered SSE frame data or equivalent provider chunks before translation.
- **Normalized response:** ordered `ProviderEvent` values emitted by `ProviderPort`.
- **Runtime evidence:** tool, approval, cancellation, and process observations that are not automatically model-visible.

## Decision 1: Four truths remain separate

| Truth | Canonical owner | Failure consequence |
| --- | --- | --- |
| Product/conversation state | Durable session records | Engine correctness failure |
| Diagnostic evidence | Trace bundle | Debug information missing; turn continues |
| Immediate presentation | Live events | UI catches up from durable records |
| Operational aggregates | Telemetry/metrics | Monitoring information missing; turn continues |

Trace events SHALL NOT be added to `packages/protocol` durable records. Deleting every trace bundle must leave conversation replay unchanged. Conversely, a trace may refer to durable record IDs and sequences to explain correspondence, but it may not become the source of product state.

Rejected: extend every durable record with raw request/response data. This makes a diagnostic concern part of the frozen product contract, duplicates large payloads, and turns trace retention into conversation retention.

## Decision 2: Observe ordered evidence first; reduce it later

The hot path appends small ordered trace envelopes and writes large payloads behind references:

```text
trace bundle/
  manifest.json
  trace.jsonl
  payloads/
    <payload-id>.json
  state.json             # optional/rebuildable reduced view
```

The trace writer owns a monotonic `traceSequence`. It writes a payload before appending an event that refers to it. A deterministic reducer produces the semantic view consumed by APIs and UI.

```text
runtime observations -> trace.jsonl + payloads -> reducer -> semantic trace view
```

This follows Codex's useful separation between raw evidence and a reduced graph. It also prevents provider and tool hot paths from accumulating UI-specific state.

Rejected: construct the final viewer model inside the adapter. That couples provider parsing to UI needs and makes replay tests impossible.

## Decision 3: The unit of provider observation is an attempt

Every concrete upstream call gets a unique `attemptId`. Every trace event carries the scope available at its source:

```text
conversationId
sessionId
turnId
stepId
attemptId
toolCallId? / approvalId?
```

Retries are siblings, not mutations:

```text
step_1
  attempt_1  failed: transport
  attempt_2  completed: tool-use
```

This is required to diagnose retry and fallback behavior. A turn-level request capture would silently overwrite the failed attempt with the successful one.

## Decision 4: Capture semantic context and wire request separately

Before entering the provider adapter, `ProviderStepRunner` records a semantic snapshot:

```ts
{
  history: request.history,
  tools: request.tools,
  contributions: [
    { kind: "conversation-history", ... },
    { kind: "tool-definitions", ... },
    { kind: "workspace-instructions", ... },
    { kind: "memory", ... }
  ]
}
```

After `request.ts` translates that snapshot, the adapter records the exact body supplied to `fetch`:

```ts
{
  model,
  stream: true,
  messages,
  tools,
  tool_choice: "auto"
}
```

Both are necessary. The semantic snapshot answers whether Turnturn selected a fact. The wire request answers whether provider translation preserved it.

“Exact request” means exact request body, URL route, HTTP method, provider name, and non-secret transport metadata. Authorization, cookies, API keys, OAuth credentials, and arbitrary configured headers are not model context and SHALL NOT enter the trace. This is exclusion at capture time, not post-capture scrubbing.

## Decision 5: Preserve three response layers

For each attempt, capture:

1. raw ordered stream frames/chunks;
2. normalized `ProviderEvent` values;
3. terminal attempt outcome, usage, status, provider request ID when available, and timing.

This gives a complete translation chain:

```text
SSE data frame
  -> tool_calls argument delta
  -> ProviderEvent.tool-call-arguments-delta
  -> ProviderEvent.tool-call-complete
  -> durable tool.requested
```

Raw stream capture is bounded per attempt. Crossing the bound appends one explicit `payload-truncated` observation and continues recording semantic terminal facts. The first implementation default is 10 MiB per attempt, configurable only at server startup. Semantic request bodies are not silently truncated.

Codex currently records completed response items rather than every delta; Gemini's response recorder retains generated response chunks for replay. Turnturn keeps raw frames because diagnosing a stream adapter is a present requirement, not merely aggregate model behavior.

## Decision 6: Runtime production and model visibility are distinct

A tool has two relevant moments:

```text
attempt A produced tool call
  -> validation / policy / approval / execution
  -> tool produced result
  -> attempt B request included that result
```

The trace reducer creates provenance links rather than treating the tool result as model-visible immediately:

- `attempt-produced-tool-call`
- `tool-produced-result`
- `request-included-tool-call`
- `request-included-tool-result`

This supports the exact question that triggered the work: “tools existed, but did this model call receive them?” It also leaves a natural path for future memory and compaction contributions without pretending those systems exist today.

## Decision 7: One optional no-op-capable observation port

The engine and provider paths receive one observation handle whose disabled implementation accepts every call and does nothing. The intended shape is descriptive, not the final TypeScript spelling:

```ts
interface ObservationPort {
  startProviderAttempt(scope: ProviderAttemptScope): ProviderAttemptObservation;
  observeTool(event: ToolObservation): void;
  observeApproval(event: ApprovalObservation): void;
}

interface ProviderAttemptObservation {
  semanticContext(value: JsonValue): void;
  wireRequest(value: JsonValue): void;
  rawResponseFrame(value: JsonValue): void;
  providerEvent(value: ProviderEvent): void;
  complete(outcome: ProviderAttemptOutcome): void;
}
```

The attempt handle owns a terminal guard: completed, failed, and cancelled are mutually exclusive. Observation methods never throw into engine behavior. Writer failures are reported through ordinary process logging and disable or degrade that trace only.

Rejected alternatives:

- `AsyncLocalStorage`: correlation becomes ambient and invisible in tests.
- An HTTP proxy: useful for fixture capture, but it cannot see provider-neutral history, policy, approvals, or which runtime output later became model-visible.
- A wrapper around `ProviderPort` alone: it can see `ProviderRequest` and `ProviderEvent`, but not the exact adapter-specific wire body or raw pre-parser frames.

## Decision 8: Trace storage is a session sidecar

Trace data lives under the server-owned state directory beside, but not inside, the session log:

```text
conversations/<conversation>/sessions/<session>/
  records.jsonl
  traces/<trace-id>/...
```

One trace covers one root turn and all its provider attempts/tools. The trace manifest stores schema version, trace ID, conversation/session/turn identity, capture time, provider, and model. Trace identity is separate from turn identity so repeated diagnostic captures or imported traces remain representable.

Trace capture is opt-in through server configuration and enabled for the local dogfood profile. Removing a trace directory is recoverable and does not change session state. Trace schema versions independently from the durable protocol schema.

## Decision 9: Context is presented as contributions, not one JSON blob

The reducer projects an ordered model-visible message list and a contribution summary:

| Contribution | Initial source |
| --- | --- |
| System/developer instructions | Provider request configuration, currently empty where unsupported |
| Conversation history | Reduced provider history |
| Tool definitions | `ToolExecutorPort.definitions()` |
| Tool interactions | Tool call/result items in history |
| Workspace instructions | Future wiring of existing instruction discovery |
| Compaction | Future compaction records |
| Memory | Future memory port |

Every category reports presence, item count, approximate tokens when available, and provenance. An empty category is shown as empty rather than omitted, so “memory not implemented” is distinguishable from “memory existed but was not sent.” Provider usage remains authoritative for total billed/input tokens; category token counts are labelled estimates.

## Decision 10: Read-only, scoped API; on-demand UI

The server exposes trace summaries and reduced traces only within an explicit conversation/session path. Large raw payloads load through a separate payload endpoint. All IDs are validated and scope mismatches return not found.

Proposed surface:

```text
GET /api/conversations/:conversationId/sessions/:sessionId/traces?turnId=...
GET /api/conversations/:conversationId/sessions/:sessionId/traces/:traceId
GET /api/conversations/:conversationId/sessions/:sessionId/traces/:traceId/payloads/:payloadId
```

The React application adds an inspector opened from a turn, with five views:

```text
Context | Request | Response | Tools | Runtime
```

The normal transcript does not display trace sequences, payload IDs, raw frames, or provider JSON. The inspector is read-only and does not acquire command submission capability. It updates during a running turn by refetching incremental trace state when existing product lifecycle events arrive; a second diagnostic SSE contract is deferred until measured refetch behavior proves insufficient.

## Decision 11: Telemetry remains a later projection

Latency, status, retry count, token usage, tool duration, and failure classifications can later be aggregated from trace/runtime observations, but content-rich traces SHALL NOT be uploaded as telemetry by this change.

Codex's split between local rollout traces and operational telemetry is the model. Gemini's OpenTelemetry integration is useful for aggregate spans and external viewers, but adopting OTel is not necessary to answer the immediate product-debugging question.

## Decision 12: Tests prove non-interference and correspondence

The acceptance suite must establish:

- disabled observation produces no trace and does not change records/events/outcomes;
- every observation method may fail without changing the terminal turn state;
- the recorded wire body deep-equals the body supplied to the HTTP client;
- retry creates two attempts and preserves both outcomes;
- raw frames map in order to normalized provider events;
- a tool result is not marked model-visible until a later request actually includes it;
- trace APIs cannot cross conversation or session boundaries;
- no trace payload contains configured credentials or configured arbitrary headers;
- two sessions may trace concurrently without sharing sequence or payload state;
- deleting trace bundles leaves durable replay and reducer results unchanged;
- the inspector can explain a turn where tools were sent even when the assistant text claims otherwise.

## Implementation Boundary

Expected ownership, subject to validation during implementation:

```text
packages/assistant-core/src/observability/
  types.ts             # observation vocabulary and no-op implementation
  context.ts           # scoped turn/step/attempt handles

packages/assistant-core/src/provider-step-runner.ts
packages/assistant-core/src/tool-wave-runner.ts
packages/assistant-core/src/providers/openai-chat-completions/{request,http,adapter}.ts

packages/assistant-server/src/observability/
  trace-writer.ts
  trace-reader.ts
  trace-reducer.ts
  trace-store.ts

packages/chat-client/src/trace-transport.ts
apps/web/src/components/developer/turn-inspector/*
```

Do not create a generic event bus, a generic JSON utility, or a second durable-record reducer. The observation vocabulary should name model/provider/runtime facts directly.

## Resolved Review Decisions

Approved on 2026-09-17:

1. Raw response-frame capture is bounded at 10 MiB per provider attempt, with explicit truncation metadata.
2. Tracing is enabled by default in the local dogfood profile and disabled by default elsewhere.
3. Traces initially live for the lifetime of their conversation; a separate retention policy is deferred until real storage measurements exist.
4. The first inspector refetches incremental trace state when existing product lifecycle events arrive. A dedicated diagnostic SSE stream is deferred until measured behavior proves it necessary.
5. “As-is” means exact model-visible request and response bodies. Authorization, cookies, API keys, OAuth credentials, and arbitrary transport headers are excluded before capture.
