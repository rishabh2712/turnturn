# Recommended Design v1

Status: validated recommendation
Date: 2026-09-08

## Recommendation

Build turnturn v1 as a TypeScript, event-first coding harness with Codex-inspired runtime boundaries, Gemini-inspired SDK/tool ergonomics, and agentic-code-inspired operational invariants.

Do not copy any reference repo wholesale. The design path is:

- Use Codex's conceptual model: `Conversation -> Session -> Turn -> Step -> Item`.
- Use Gemini CLI's TypeScript-facing ergonomics: `agent()`, `session()`, `sendStream()`, `resumeSession()`, `tool()`, typed registries, and a small explicit loop context.
- Use agentic-code's robustness rules: every `tool_use` must receive a `tool_result`, recoverable tool errors stay in the loop, and render/SDK messages are adapters over canonical internal events.

## Validated Architecture

### 1. Core Runtime Model

turnturn v1 should model:

- `Conversation`: durable user-visible continuity.
- `Session`: runtime environment, provider configuration, tool registry, policy runtime, and cancellation scope.
- `Turn`: one user submission and all model/tool work required to answer it.
- `Step`: one provider request/stream cycle inside a turn, with frozen settings and tool declarations.
- `Item`: canonical persisted event/message unit.

Why: Codex's session/turn/step split gives replay correctness and keeps settings from drifting mid-step. agentic-code confirms one lifecycle owner per conversation is practical. Gemini confirms the same ideas can be exposed through a friendly TypeScript SDK.

Tradeoff: This is more structure than a simple chat loop, but it prevents future resume, tracing, provider switching, and UI coupling problems.

### 2. Canonical Event Protocol

Create one internal protocol before building UI:

- `conversation.created`
- `session.created`
- `turn.started`
- `step.started`
- `model.delta`
- `model.completed`
- `tool.requested`
- `approval.requested`
- `approval.resolved`
- `tool.running`
- `tool.completed`
- `tool.failed`
- `tool.aborted`
- `step.completed`
- `turn.completed`
- `turn.failed`
- `usage.recorded`

Why: Codex and Gemini both show the value of event-first runtimes. Gemini also shows the cost of multiple event planes and translators. agentic-code shows the danger of lossy SDK/UI adapters becoming de facto truth.

Tradeoff: A canonical protocol costs more upfront design, but keeps provider, SDK, remote, and UI adapters replaceable.

### 3. Provider Layer

Provider adapters should transform canonical turn requests into provider-native requests and transform provider streams back into canonical events.

The core engine must not expose Gemini `Content`, OpenAI response items, Anthropic content blocks, or local-model formats as its public internal shape.

Why: Gemini's provider-shaped types leak through many layers. Codex's provider capability layer is a better conceptual target, but turnturn v1 should keep it smaller.

Tradeoff: Adapters will do more mapping work, but the engine remains provider-neutral.

### 4. Tool Runtime

Adopt this split:

- `ToolDefinition`: name, description, schema, capabilities, approval hints, parallel-safety.
- `ToolInvocation`: one validated call with immutable call ID and input.
- `ToolPolicy`: allow, deny, ask, abort, or modify input.
- `ToolScheduler`: sequential first, parallel waves later.
- `ToolExecutor`: runs one invocation and emits lifecycle events.
- `ToolOrchestrator`: coordinates policy, scheduler, executor, persistence, and tracing.

Why: Gemini's declaration/invocation/scheduler split is the cleanest TypeScript implementation guide. Codex's router/runtime/orchestrator shows how to keep policy centralized. agentic-code confirms a single `runToolUse` hotspot becomes powerful but too large if not split.

Tradeoff: More interfaces, fewer hidden side effects.

### 5. Sequential First, Parallel Waves Later

Phase 1A executes tools sequentially. Phase 1E adds waves:

- Default tool behavior is non-parallel.
- Read-only or isolated tools may opt into `supportsParallel: true`.
- Mutating tools serialize unless they explicitly provide isolation.
- Results are returned to the provider in original call order.
- One sibling failure does not cancel unrelated siblings.

Why: Codex validates opt-in parallelism with deterministic result grouping. agentic-code validates batching but warns about ordering/cancellation hazards. The user explicitly requested sequential first, then waves.

Tradeoff: Latency is worse early, but correctness and approval semantics are easier to prove.

### 6. Approval and Cancellation

Approvals are a serializable service, not UI callbacks:

- Policy checks run before tool execution.
- Approval requests are canonical events.
- Each approval resolves once.
- Approval abort can cancel the targeted tool.
- Tool abort/failure should produce a model-visible tool result where safe.

Why: agentic-code's `resolve once` pattern is important. Codex shows approvals, sandboxing, and network policy belong outside individual tools. Gemini's confirmation bus is the right ergonomic direction, but callback-heavy confirmation should not become the durable protocol.

Tradeoff: Approval UX must adapt to the engine protocol rather than owning it.

### 7. Persistence, Hydration, Recall, Replay

Start with append-only canonical events. Use filesystem JSONL or SQLite for v1, but keep the interface storage-agnostic.

Required behavior:

- Persist tool calls before executing them.
- Persist tool results separately with stable `callId`.
- Distinguish durable events from ephemeral progress.
- Hydration rebuilds runtime state from events.
- Replay rebuilds model-visible history deterministically.
- Recall selects relevant summaries/facts/context without mutating raw history.

Why: Codex proves replay and reconstruction matter. agentic-code proves append-only persistence is robust, but parent chains, tombstones, sidecars, and compaction can become maintenance-heavy. Gemini validates append-friendly records and session resume.

Tradeoff: Event logs are verbose, but debuggable and migration-friendly.

### 8. Memory and Subagents

For v1, define the boundary but keep implementation small:

- Memory starts as explicit summaries and durable facts.
- Consolidation is asynchronous and auditable.
- Memory injection is separate from replay.
- Subagents are child sessions with parent linkage, scoped tool access, and summary handoff.
- Do not implement full agent trees, prompt-cache-identical forks, or rich multi-agent UI in v1.

Why: Codex treats subagents as real threads with lineage and persistence. agentic-code treats subagents as query loops with product-visible task wrappers. Both are useful, but too large for v1.

Tradeoff: We leave some multi-agent power on the table so the base harness remains coherent.

## Implementation Order

1. `packages/protocol`: canonical IDs, messages, events, errors, statuses.
2. `packages/engine`: conversation/session/turn/step state machine and async event stream.
3. `packages/providers`: scripted provider first, then one real provider adapter.
4. `packages/tools`: definition/invocation/runtime interfaces and sequential orchestrator.
5. `packages/policy`: serializable policy decisions and approval lifecycle.
6. `packages/persistence`: append-only event store, hydration, replay fixtures.
7. `packages/observability`: trace IDs and turn timeline renderer.
8. Parallel waves.
9. Memory summaries/facts.
10. Minimal child sessions/subagents.

## Design Rejections

- Reject UI-first orchestration: too much future coupling.
- Reject provider-native persistence: blocks replay and provider switching.
- Reject full parallelism in Phase 1A: approval and filesystem semantics are not ready.
- Reject a broad mutable tool context: split runtime dependencies by concern.
- Reject full Codex parity: too much production compatibility surface.
- Reject Gemini's multiple event planes: start with one canonical event protocol.
- Reject agentic-code's query-loop gravity well: keep orchestration layers separated.

