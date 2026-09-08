# Codex Explorer Report

Read-only review complete.

## Observed Files

- `../codex/codex-rs/core/src/session/turn.rs`: main turn loop; user turn becomes repeated model sampling steps until no follow-up is needed.
- `../codex/codex-rs/core/src/session/step_context.rs`: request-scoped snapshot of settings, tools, MCP, environment, telemetry.
- `../codex/codex-rs/core/src/session/session.rs`: session/thread runtime state, active turn, input queue, services.
- `../codex/codex-rs/protocol/src/turn_input.rs`: public turn input, start/steer/recover semantics.
- `../codex/codex-rs/core/src/client.rs`: model-provider execution client; session-scoped `ModelClient`, turn-scoped `ModelClientSession`.
- `../codex/codex-rs/model-provider/src/provider.rs`: provider capability/auth/error abstraction.
- `../codex/codex-rs/core/src/tools/router.rs`, `../codex/codex-rs/core/src/tools/registry.rs`: model-visible tool names to executable runtimes.
- `../codex/codex-rs/core/src/tools/parallel.rs`: parallel/sequential execution gate and cancellation isolation.
- `../codex/codex-rs/core/src/tools/orchestrator.rs`, `../codex/codex-rs/core/src/tools/approvals.rs`: approvals, sandbox selection, retry, network policy.
- `../codex/codex-rs/core/src/context_manager/history.rs`, `../codex/codex-rs/core/src/session/rollout_reconstruction.rs`, `../codex/codex-rs/state/thread_history_migrations/0001_thread_history.sql`: history persistence, hydration, replay.
- `../codex/codex-rs/core/src/agent/control.rs`, `../codex/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`: subagent control plane.

## Architectural Lessons

- Codex separates `session/thread`, `turn`, and `step`: a turn is user-visible work; a step is one model request with frozen tools/settings/environment.
- Tool calls are persisted as model items before execution, then outputs are appended later. That makes cancellation and replay much saner.
- Tool policy is centralized. Individual tools implement execution traits; approvals, sandboxing, network approval, retry, and telemetry are owned by the orchestrator.
- Parallelism is opt-in per tool. A shared `RwLock` allows parallel-capable tools through read locks and serializes exclusive tools with a write lock.
- Provider boundary is capability-oriented: tools/features/remote compaction/auth recovery are capped by provider capabilities, while per-turn model settings stay explicit.
- Persistence is event-log-first, with SQL projections for thread/turn/item lookup. Replay reconstructs not only transcript but settings, compaction windows, retained context, world state, rollback effects.
- Subagents are real threads with lineage, identities, config inheritance, communication, capacity limits, and persistence, not just nested prompts.

## Tradeoffs Codex Makes

- Strong replay correctness over simplicity. The architecture carries many metadata layers to make resume/fork/rollback/compaction work.
- Step snapshots prevent drift, but create many “current vs captured” concepts.
- Parallel tool execution improves latency, but only after a conservative per-tool safety declaration.
- Central policy makes behavior consistent, but all tools must fit the orchestrator’s approval/sandbox mental model.
- Subagents share filesystem/runtime by default, which is efficient but requires careful coordination and attribution.
- Compaction replaces the model window while retaining host-owned facts, trading implementation complexity for long-running session continuity.

## Recommendations For turnturn v1

- Model the core as `Conversation -> Session -> Turn -> Step -> Item`, but keep v1 minimal: one active turn per session, many steps per turn.
- Make `StepContext` immutable and include provider, model settings, tool plan, environment, policy, trace ids.
- Persist every model-emitted tool call before running it; append tool result as a separate item with stable `call_id`.
- Build a `ToolRouter` plus `ToolRuntime` interface, and a central `ToolOrchestrator` for approval/policy/retry.
- Add explicit `supports_parallel` on tools; default to sequential.
- Use a per-turn cancellation token and child tokens for model stream/tool calls. Tool cancellation should produce model-visible aborted output where possible.
- Store an append-only event log first; add projections later. Hydration should replay into a deterministic in-memory `ContextManager`.
- Treat compaction as a checkpoint item with replacement history plus retained host facts. Do not make summaries mutate opaque transcript text in place.
- For v1 subagents, start with “child turn/task records plus mailbox messages”; defer full persistent agent trees unless they are core to the product.

## Risks If Copied Too Literally

- Codex carries production concerns: MCP, plugins, Guardian, realtime, app-server, multi-agent v2, rollout migration. Copying the shape wholesale would overload turnturn v1.
- The session/turn/step boundary is excellent, but the surrounding compatibility layers are expensive.
- Full subagent parity would dominate the architecture before the base turn engine is stable.
- Replay correctness depends on many invariants; copying partial pieces without the tests and projections may create fragile hydration bugs.
- Provider abstraction is useful, but v1 should avoid baking in OpenAI-specific websocket/sticky-routing assumptions unless turnturn actually needs them.

