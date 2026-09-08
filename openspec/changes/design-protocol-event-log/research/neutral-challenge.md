# Neutral Challenge: Protocol and Event Log

## Core Challenge

Canonical durable events are a credible long-term foundation, but the current proposal has not demonstrated that full event sourcing is the smallest foundation Turnturn needs.

Strongest arguments against adopting full event sourcing now:

- The engine domain is not implemented yet; freezing a rich taxonomy before the sequential loop exists risks migration debt.
- Replay currently conflates rebuilding engine state, reconstructing provider-visible history, and replaying a UI timeline.
- Append-only persistence brings responsibilities immediately: atomic writes, duplicate commands, corrupt tails, migration, redaction, retention, snapshots, and interrupted transitions.
- A canonical event model can become a lowest-common-denominator provider model if provider ordering, partial tool arguments, stop reasons, reasoning, and usage semantics are flattened too early.
- Local single-process v1 does not need global distributed machinery such as arbitrary causal arrays, fanout, backpressure, or full resumable remote streams.
- Durable events are not a source of truth unless reducer versions and invariants are defined.
- `ROADMAP.md` promises implementation and append-only persistence, while `tasks.md` was initially only research/design; scope must be reconciled.

## Three Envelope Assessment

Three semantic planes are appropriate:

- Durable facts for recovery and model-history reconstruction.
- Ephemeral progress for live presentation.
- Control-plane intent for commands, approvals, and cancellation.

Three fully independent protocol frameworks would be premature.

Practical staging:

- `CommandEnvelope` for intent.
- `DurableRecord` with storage-assigned session sequence.
- `LiveEvent` projection that may reference a durable record but is not replayable and does not consume the durable cursor.

Control-plane outcomes should become durable facts only when they change state. Command acknowledgements and stale-client warnings need not enter the event log.

## V1 Should Include

- One ordering authority and one monotonic sequence domain per session log.
- Typed IDs for session, turn, step, tool call, approval, command, and durable record.
- Narrow command set: submit input, resolve approval, cancel turn/tool call.
- Durable records for accepted user input, finalized assistant content, tool request, terminal tool result, approval request/resolution, and terminal turn state.
- Structured serialized errors with retryability and fatality.
- Idempotent command handling and duplicate event-ID rejection.
- Append/read storage behavior, including partial trailing-record recovery.
- Exact approval/cancellation race linearization.
- Provider-history and engine-state reducers as separately named projections.
- Fixtures for happy path, denial, cancellation while awaiting approval, cancellation while running, duplicate approval response, duplicate command, corrupt tail, and cursor resume.
- Multiple tool calls emitted by one provider step, even though execution remains sequential.

## V1 Should Defer

- Parallel execution, causal graphs, and arbitrary `causalEventIds`.
- HTTP, SSE, WebSocket, fanout, backpressure, and remote-worker behavior.
- Compaction checkpoints and replay snapshots.
- Durable text/reasoning/output deltas.
- Full provider-stream taxonomy and provider adapter implementation.
- Memory, subagents, branching, rewind, and transcript mutation.
- Fine-grained session/provider-request cancellation unless a concrete v1 caller needs it.
- Durable usage records unless billing or recovery requires them.

## Hidden Assumptions

- Transport assumes one ordered writer, append-before-publish, no replay/live subscription gap, cursor availability, and efficient `afterEventId` lookup.
- App/session boundary assumes one process owns routing and pending approvals.
- Provider adapters assume partial tool JSON, multiple simultaneous tool requests, provider IDs, reasoning retention, finish reasons, and usage corrections can map cleanly.
- Approvals assume one approval per tool call, immutable proposed input, no expiry, no actor identity, and no persistent policy update such as always-allow.
- Cancellation needs a precise meaning for accepted: recorded, signalled, or prevented.
- Replay determinism depends on reducer version, unknown-event behavior, migration policy, duplicate handling, incomplete transition handling, redaction, and synthetic-result rules.
- Sequential execution does not remove the need to represent multiple tool calls emitted by one provider step.

## Simpler Alternatives

- Canonical transcript plus lifecycle journal: faster for local sequential operation, but creates two stores that need reconciliation.
- Transactional state store with outbox: simple current-state queries and reliable notifications, but less portable and less inspectable than JSONL.
- Minimal write-ahead operation log: captures user input, model output, tool requests/results, and terminal turn state while deriving progress live. This is the strongest simpler alternative.

## Reference Risks To Avoid

- From Codex: do not copy broad rollout unions, selected live-event persistence, app-server item taxonomy, or compaction machinery before needed.
- From Gemini CLI: avoid stream-local IDs, in-memory-only resume, callback/promise leakage, and separate scheduler/public-event truth planes.
- From agentic-code: avoid mixed JSONL taxonomies, progress entries in transcript parent chains, shape-based tool-result detection, fire-and-forget durability, and repair logic that silently synthesizes model-visible results.

## Recommendation

Conditional go.

Proceed on a durable foundation only if Milestone 2 narrows the durable taxonomy, separates durable cursor semantics from ephemeral progress, defines append/publish atomicity and command idempotency, specifies approval/cancellation race precedence, distinguishes engine-state replay from provider-history projection, handles multiple tool calls per step, adds adversarial replay fixtures, and reconciles `tasks.md` with `ROADMAP.md`.

If those conditions make the design substantially larger, choose the minimal write-ahead operation log for v1 and evolve it using observed engine behavior.
