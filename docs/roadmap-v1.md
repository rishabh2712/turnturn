# turnturn v1 Roadmap

Status: frozen for first implementation planning
Date: 2026-09-08

## v1 Goal

Build the first coding harness for turnturn: an engine that can run an agent loop, invoke tools through explicit policy gates, persist and hydrate sessions, and emit observable events that a CLI or UI can render without becoming coupled to the engine.

## Design Inputs

- Codex harness: session/turn/step separation, event-first architecture, provider abstraction, tool runtime, permission profiles, cancellation, state persistence, and tracing.
- Gemini CLI: TypeScript SDK ergonomics, `AgentLoopContext`, tool registries, confirmation bus, session/resume APIs, and strongly typed tool abstractions.
- agentic-code: `QueryEngine` as conversation lifecycle owner, one engine per conversation, turn-scoped submission, permission-denial tracking, session history, and remote/local rendering boundaries.
- OpenSpec: specs and changes remain the task-management source of truth, with roadmap decisions captured before implementation.

## Phase 1A: Harness Spine

Deliver a minimal engine that can run a single conversation with sequential tool calls.

- Canonical message model for user, assistant, reasoning, tool call, tool result, status, and error events.
- Provider layer that transforms canonical requests into provider-specific payloads and converts provider stream events back into canonical events.
- Agent loop that samples, detects tool requests, executes tools, feeds results back, and stops on final assistant output or explicit stop condition.
- Tool registry with tool declarations, input schema, execution function, capability tags, approval requirement, and parallel-safety metadata.
- Policy gate before tool execution, supporting allow, deny, ask, abort, and modified-input decisions.
- Event bus that emits model, tool, approval, persistence, and error lifecycle events.

Exit criteria:

- A scripted test provider can drive a complete user turn with one or more sequential tool calls.
- A test renderer can subscribe to the engine event stream without importing engine internals.
- Tool denial and tool failure are represented as tool results where possible, not process-level crashes.

## Phase 1B: Session Persistence

Make turns durable and resumable.

- Session creation separated from conversation creation.
- Conversation owns user-visible continuity; session owns runtime environment and provider state.
- Append-only event store for conversations, turns, tool calls, approvals, errors, and summaries.
- Hydration path that reconstructs engine state from canonical events.
- Recall path that selects relevant prior state for the next turn.
- Replay path that can rebuild model-visible history deterministically from stored events.
- Migration-ready storage boundary, starting with filesystem JSONL or SQLite and avoiding provider-shaped persistence.

Exit criteria:

- A process restart can resume a conversation and continue a new turn.
- Hydrated state matches a deterministic replay fixture.
- Persisted events are provider-neutral.

## Phase 1C: Error, Cancellation, and Approval Semantics

Make failures local and observable.

- Per-turn cancellation token and per-tool cancellation token.
- Approval abort can cancel the targeted tool before execution or interrupt an in-flight tool where supported.
- Sibling tool calls are isolated: one rejection, abort, timeout, or execution error does not corrupt unrelated siblings.
- Agent loop receives structured tool error results unless the error prevents loop continuation.
- Fatal engine errors are classified separately from recoverable tool errors.
- User-initiated abort, policy denial, provider stream failure, malformed tool call, timeout, and renderer disconnect get distinct event types.

Exit criteria:

- Tests prove a denied tool does not block later user turns.
- Tests prove sibling tool failures do not erase successful sibling results.
- A provider stream error leaves the conversation resumable.

## Phase 1D: Observability and Traceability

Make every turn debuggable.

- Trace IDs for conversation, session, turn, provider request, tool call, approval request, and persistence write.
- Structured lifecycle events with timestamps, parent IDs, duration, status, and error classification.
- Request/response redaction policy for secrets and large output.
- Turn timeline renderer for debugging.
- Decision log linked from specs/tasks to implementation choices.

Exit criteria:

- A single turn can be inspected as a timeline from user input to final assistant output.
- Every tool call has a matching requested/running/completed or failed event.
- Every major architecture decision has a source and tradeoff note.

## Phase 1E: Parallel Tool Waves

Add concurrency after the sequential spine is stable.

- Tool scheduler groups model-requested calls into waves.
- Default execution is sequential until tool metadata explicitly marks a tool as parallel-safe.
- Read-only and side-effect-isolated tools may run in parallel.
- Mutating tools remain serialized unless their executor declares isolation.
- Results are returned to the model grouped by original call order, even if execution completes out of order.
- Wave-level cancellation does not imply turn-level cancellation unless policy says so.

Exit criteria:

- Parallel-safe tools overlap in time under test.
- Non-parallel tools wait for active parallel wave completion.
- Result ordering remains deterministic.

## Phase 1F: Memory and Subagents

Design, but do not overbuild, the next layer.

- Memory starts as explicit session summaries and durable facts extracted from completed turns.
- Consolidation is asynchronous and auditable.
- Memory injection is separate from raw conversation replay.
- Subagents are child sessions with parent conversation linkage, scoped tool access, and isolated event streams.
- Parent receives subagent summaries and artifacts, not raw internal state by default.

Exit criteria:

- Memory and subagent boundaries are specified enough that Phase 2 can implement them without reshaping the Phase 1 engine.

## Non-Goals for v1

- Full IDE integration.
- Rich multi-agent planning UI.
- Cloud sandbox orchestration.
- Long-term semantic memory retrieval beyond explicit summaries/facts.
- Provider-specific feature completeness.

