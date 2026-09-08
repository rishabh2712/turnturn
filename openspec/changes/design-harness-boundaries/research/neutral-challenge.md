# Neutral Challenge

Status: complete

## Review

Conditional go, not a clean go. The direction is plausible, but the current design is not yet implementation-ready because several boundaries are named without enough enforceable contract underneath them.

## Strongest Arguments Against The Current Approach

The design may be too broad for a v1 boundary milestone. The roadmap asks for ten boundary decisions before engine code starts, from transport through memory/subagents, but the design mostly lists ownership areas rather than resolving hard tradeoffs.

The “transport-safe protocol but only in-process implementation” choice is risky. The draft admits in-process-only may hide serialization problems, then chooses that path without requiring a real serialization test harness or fixture.

The design may be importing the nouns from Codex, Gemini, and agentic-code without importing the invariants that make those systems work. The research repeatedly warns against partial copying: replay correctness depends on many invariants, Gemini has too many event planes, and agentic-code’s append-only/session model carries load complexity.

## Hidden Assumptions

The design assumes JSON-serializable command/event types are enough to preserve future transport freedom. They are not. Ordering, idempotency, backpressure, reconnection, error semantics, cancellation semantics, and version negotiation are also required.

It assumes append-only canonical events can be the source of truth without first specifying event identity, causality, schema evolution, durable versus ephemeral write rules, and replay determinism.

It assumes the engine should own persistence writes directly. That may be correct, but it creates a subtle coupling: the engine becomes both state machine and storage transaction coordinator.

It assumes memory and subagents can be “interfaces only” in v1 while still reserving architectural shape for them. Premature placeholder interfaces can harden into awkward APIs before real use cases exist.

## Missing Alternatives

A stricter “protocol/event-log first” milestone before any engine boundary could be cleaner.

A deliberately monolithic local engine with only three hard seams could be simpler for v1: provider adapter, tool executor, event log.

A thin local HTTP/SSE harness from day one should be considered seriously. It is slower initially, but it would force serialization, subscription resume, cancellation, and approval routing to be real instead of theoretical.

A “scripted provider plus fake executor” vertical slice may reveal more than more boundary design. One completed turn with a tool call, approval, cancellation, persistence, and replay would test the architecture faster than naming every future adapter.

## Sequencing Risks

The roadmap puts protocol/event log in Milestone 2 and sequential loop in Milestone 3, but the boundary design already depends on protocol, event identity, durable/ephemeral distinction, and replay. That creates a sequencing inversion.

Deferring local transport/renderer until Milestone 4 may allow engine APIs to become too in-process and callback-shaped.

Parallelism is postponed to Milestone 6, which is sensible, but the tool scheduler boundary is already included in v1 terminology. The risk is designing a scheduler abstraction before serial execution proves what statuses and failure modes are actually needed.

## Where Simpler Architecture May Be Better

The app/session facade may be unnecessary in v1 unless there is already more than one client. A session service can be a module-level API until transport becomes real.

Memory and subagent interfaces should probably be removed from v1 surface area unless the event schema needs lineage fields now.

Observability can start as structured engine events plus trace IDs, not a separate conceptual subsystem.

## Where More Upfront Rigor Is Necessary

The event model needs rigor before implementation: event IDs, stream IDs, sequence ordering, parent/causal IDs, durable versus ephemeral rules, schema versioning, and replay guarantees.

The tool-use/tool-result invariant needs a formal state machine. Every assistant tool use must receive a corresponding result, including aborts and errors.

Approval resolution needs exact semantics: once-only resolution, stale approval handling, denial result shape, cancellation race behavior, and whether approval events are durable.

Provider neutrality needs a capability matrix, not just “no provider-native durable truth.” Streaming deltas, tool calls, usage, reasoning, multimodal inputs, token counting, and cancellation differ enough that a vague adapter boundary will leak.

## Questions Before Implementation

- What is the minimal canonical event list for the first completed replay fixture?
- Are event IDs globally monotonic, session-local monotonic, ULIDs, or storage-assigned sequence numbers?
- Can an in-process transport test prove that every command/event round-trips through JSON serialization with no functions, class instances, symbols, Dates, or provider-native objects?
- What happens if cancellation occurs after a tool request is persisted but before the tool result is written?
- Is persistence synchronous with engine state transitions, or can events be buffered? If buffered, what is the crash consistency model?
- Does v1 require hydration, or only replay fixtures?
- What is the smallest policy model that still covers allow, deny, ask, abort, and modified input?
- Which identity fields are needed now for future subagents without committing to subagent execution?

## Recommendation

Conditional go. Proceed only if the next step is to harden this draft into a narrower implementation gate, not to start engine code immediately.

Minimum conditions:

- Complete synthesis.
- Convert the boundary map into enforceable contracts for protocol events, tool state, approvals, cancellation, and persistence.
- Add at least one required round-trip serialization/replay fixture before relying on `InProcessTransport`.
- Cut or explicitly defer app facade, memory, subagents, remote transport, and rich observability unless needed by the first vertical slice.

Not a no-go on the architecture direction, but no-go on implementation from the current draft as-is.

