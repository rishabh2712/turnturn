# Tasks: Model-Turn Observability

Do not implement until `design.md` is reviewed. Work in order. Begin each behavior with a failing test. Do not edit `packages/protocol`.

## Working Conventions

- Durable records remain product truth. Trace data must never participate in engine replay.
- Observation is best-effort. A failing observer must not alter command outcomes, durable records, live events, provider retry, tool execution, or terminal state.
- Capture the exact provider body before `fetch`; do not reconstruct it later from durable records.
- Exclude credentials and arbitrary configured headers at capture time. Do not rely on a later scrub pass.
- Keep semantic context, provider wire payloads, normalized events, and runtime evidence as distinct types.
- Use writer-assigned trace sequences. Never renumber filtered observations.
- Scope every read by conversation and session. A trace ID alone is not authorization or sufficient identity.
- Raw response bounds must produce explicit truncation metadata; silent truncation is a defect.
- `reduceEngineState(records).issues` and `reduceProviderHistory(records).issues` stay empty for every test that produces durable records.
- No commit unless Rishabh explicitly asks.

## Design Gate

- [x] Resolve the five open questions in `design.md`.
- [x] Resolve the capture-boundary question from `research/user-interview.md`: preserve exact model-visible bodies; exclude credentials and arbitrary transport headers before capture.
- [x] Review `research/neutral-challenge.md` and record accepted/rejected objections in `research/synthesis.md`.
- [x] Confirm the proposed public observation boundary is the minimum API change that still exposes the exact wire body and raw pre-parser frames.
- [x] Mark `design.md` reviewed before touching implementation.

## 1. Observation vocabulary and non-interference

- [x] Add typed turn, step, provider-attempt, tool, and approval observations plus a no-op implementation under `assistant-core/src/observability/`.
- [x] Add the first-class context vocabulary under `assistant-core/src/context/`: immutable identified contributions, extensible built-in kinds, explicit lifetime/source/provenance, catalog snapshots, and per-step included/excluded/unavailable selections.
- [x] Make observability consume `ModelContextSnapshot` from the context facade; it must not own context types or become the future context manager.
- [x] Test custom contribution kinds, step-specific selection, unavailable versus excluded context, and preserved derivation provenance.
- [x] Add a terminal guard to each attempt handle so complete/fail/cancel can be recorded at most once.
- [x] Test that disabled observation changes none of the existing engine outputs.
- [x] Test that an observer throwing from every method cannot prevent a durable terminal turn record.
- [x] Keep the public facade narrow; do not export trace storage or UI projection from `assistant-core`.

Acceptance: the scripted-provider engine suite produces byte-for-byte-equivalent durable records with observation disabled, deliberate trace failures do not fail a turn, and context can evolve independently of provider and trace types.

## 2. Local trace bundle

- [x] Implement a session-scoped trace store with manifest, ordered `trace.jsonl`, payload references, and independent trace schema version.
- [x] Write payloads before observations that reference them; append trace envelopes through one writer-owned sequence.
- [x] Implement deterministic replay into an initial semantic state containing turns, steps, attempts, payload references, and issues.
- [x] Recover or clearly reject a torn trace tail without modifying the durable session log.
- [x] Test concurrent traces in two sessions, missing payloads, sequence gaps, duplicate terminals, and deletion without replay impact.

Acceptance: replaying the same bundle produces deeply equal semantic state, and deleting it leaves both durable reducers unchanged.

## 3. Provider-attempt capture

- [x] Start an attempt for each concrete HTTP try, including retries and fallback when implemented.
- [x] Capture the provider-neutral `ModelContextSnapshot` in `ProviderStepRunner` before provider translation, including the current catalog and explicit selection for this step.
- [x] Capture the exact JSON body, method, route, provider, and model in chat-completions `request.ts` immediately before transport.
- [x] Capture response status, provider/upstream request ID when present, timing, normalized failure, usage, and terminal reason.
- [x] Test that the trace's wire body deep-equals the body seen by the injected HTTP client.
- [x] Test one failed first attempt followed by a successful second attempt; both must survive with distinct identities.

Acceptance: a single provider step can be explained attempt by attempt without consulting transient process state.

## 4. Stream translation evidence

- [x] Record ordered raw SSE data frames before `frames.ts` parses them.
- [x] Record each normalized `ProviderEvent` after translation.
- [x] Apply the configured raw payload bound and append one explicit truncation observation when exceeded.
- [x] Add correspondence tests for text, reasoning, interleaved tool calls, usage-after-finish, unknown finish reason, truncated tool arguments, and interrupted stream.
- [x] Verify the parser and adapter produce identical behavior with trace capture disabled, enabled, and failing.

Acceptance: the reduced trace can show a raw frame beside the provider event(s) it produced and explain protocol failure at the offending frame.

## 4R. Observation plumbing cleanup

- [x] Bundle command, cancellation runtime, and turn observation into one turn execution context instead of threading three sibling parameters through `TurnRunner`.
- [x] Keep `request.ts` pure: return wire evidence with the prepared request and let the HTTP transport invoke a narrow pre-fetch hook.
- [x] Replace parser knowledge of `ProviderAttemptObservation` with provider-local stream translation hooks.
- [x] Split server trace write scheduling and scoped observation handles out of `trace-observation-port.ts` before tool and approval capture expands it.
- [x] Preserve exact request timing, observation failure isolation, trace ordering, provider output, durable records, and both reducer invariants.

Acceptance: observation remains explicit at turn, step, attempt, and tool ownership boundaries but disappears from pure request construction, generic transport types, parser internals, and repeated turn helper parameters.

## 5. Tool and approval provenance

- [x] Observe tool validation input/result, policy decision, any modified input, approval request/resolution, execution start, bounded live output, and terminal result.
- [x] Link provider tool-call output to the runtime `toolCallId` without replacing the provider's call ID.
- [x] During later request capture, link included history tool calls/results to their runtime observations.
- [x] Test that executing a tool does not by itself mark the output model-visible.
- [x] Test a two-step round trip where the second request includes the first step's tool result.
- [x] Test deny, abort, allow-modified, cancellation during execution, and late approval resolution.

Acceptance: the trace states separately who requested a tool, what actually ran, what it returned, and which later provider attempt received that result.

## 6. Context contribution projection

- [x] Project ordered model-visible messages with roles and provider history identity.
- [x] Project the first-class contribution catalog for system/developer instructions, history, tool definitions, tool interactions, workspace instructions, compaction, memory, and extension-defined kinds.
- [x] Project each step's contribution selection, distinguishing included, excluded, and unsupported/unwired contributions with reasons.
- [x] Preserve contribution source, lifetime, and derivation links so future compaction and memory remain explainable.
- [x] Add approximate token counts per contribution and label them estimates; keep provider usage as the authoritative total.
- [x] Verify contribution counts are additive and do not count tool calls in ordinary history twice.

Acceptance: the reduced trace answers “what context did this attempt receive?” without opening raw JSON, while retaining a path to the exact body.

## 7. Read-only server API

- [x] Add session-scoped trace summary, reduced trace, and lazy payload endpoints from Decision 10.
- [x] Validate every ID and return not found for a trace outside the specified conversation/session.
- [x] Add pagination or `afterTraceSequence` for growing traces.
- [x] Ensure responses never contain Authorization, cookies, configured keys, or arbitrary configured headers.
- [x] Add server tests for two conversations with overlapping local trace sequences and for a trace growing while it is read.

Acceptance: the browser can retrieve one turn's trace without reading another session and without loading every raw payload eagerly.

## 8. Client transport and projector

- [x] Add browser-safe trace types and read methods to `chat-client`; do not expose server writer types.
- [x] Add a trace projector that builds the Context, Request, Response, Tools, and Runtime views.
- [x] Refetch incremental trace state on existing lifecycle events while the inspector is open.
- [x] Keep trace state outside the normal conversation projector so trace deletion or failure cannot change the transcript.
- [x] Test out-of-order HTTP completion, repeated payload retrieval, trace truncation, and a missing/deleted trace.

Acceptance: the same trace bundle projects identically after reload, and trace errors remain confined to the inspector.

## 9. Per-turn inspector

- [x] Add an on-demand developer action to inspect a selected turn; do not put raw diagnostics in the default transcript.
- [x] Context view: ordered messages, named contribution cards, tool catalog, presence/empty states, and estimated/authoritative token distinction.
- [x] Request view: model-context snapshot and exact provider JSON with copy controls and attempt selector.
- [x] Response view: raw frames, normalized events, completion/failure, usage, timing, and truncation notice.
- [x] Tools view: validation, policy, approval, execution, result, and later model-visibility links.
- [x] Runtime view: correlation IDs, retries, durable-record links, reducer/trace issues, and timings.
- [x] Test the motivating case: tools appear in the exact request while assistant text claims that no tools are connected.

Acceptance: an operator can explain one provider attempt without reading server files or the protocol timeline.

## 10. Dogfood and close-out

- [x] Run one LiteLLM conversation that uses at least one workspace tool and inspect both provider attempts.
- [ ] Run the same scenario against local Ollama when available.
- [ ] Verify a reload preserves the inspector and that deleting the trace leaves the chat intact.
- [x] Record the observed request/context/tool-result chain under this change's `research/` directory without credentials.
- [x] Run root lint, build, typecheck, tests, and the milestone gate.
- [ ] Update the roadmap and the coding-chat developer-mode task with the final ownership boundary.

Acceptance: the UI proves which tools and messages were sent, what the provider returned, what ran, and what the next request consumed.
