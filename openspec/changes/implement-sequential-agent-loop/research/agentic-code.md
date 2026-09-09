# agentic-code Reference Exploration

This report treats turnturn's current roadmap as a hypothesis. It infers build order from `../agentic-code` itself, not from turnturn's milestone names.

## 1. agentic-code-implied construction order

### 1. Runtime boot, config, auth, and feature gates

Why foundational: the main loop depends on environment/auth/model selection, feature gates, and service defaults before it can safely call a provider.

Evidence:
- `../agentic-code/prompts/00-overview.md` orders runtime/deps, shims, build config, MCP server build, then env/auth before UI, tools, and query engine.
- `../agentic-code/src/services/api/client.ts` builds the Anthropic client from direct API, OAuth, Bedrock, Vertex, or Foundry settings and attaches session headers.
- `../agentic-code/src/bootstrap/state.ts` centralizes session ID, project root, feature/runtime latches, strict tool-result pairing, telemetry handles, prompt/cache state, and session persistence flags.

What likely had to exist before it: package/runtime choice, config loading, environment variable conventions, auth fallback behavior.

What depends on it: provider calls, model selection, feature-gated bridge/task/streaming behavior, session identity, telemetry correlation.

Smallest useful turnturn version: local config loader, provider credential resolution, model selection, stable session ID creation, feature flags defaulting off, and a no-crash service bootstrap.

Risk if late: provider adapter and engine tests become coupled to ad hoc env reads and hardcoded model/auth decisions.

Risk if early: copying enterprise/OAuth/provider matrix too soon will slow the core harness.

Recommendation: adapt the foundation, not the breadth. Start with one local config path and one real provider credential path, but keep provider selection and session identity explicit.

### 2. Canonical message/event shapes before rendering

Why foundational: `agentic-code` has multiple consumers of messages: query loop, transcript, SDK, remote bridge, terminal UI, history/resume, and analytics.

Evidence:
- `../agentic-code/src/types/message.ts` defines pure discriminated message types with no runtime dependencies.
- `../agentic-code/src/entrypoints/sdk/coreTypes.ts` says SDK public types are generated from Zod schemas in `coreSchemas.ts`.
- `../agentic-code/src/remote/sdkMessageAdapter.ts` converts SDK messages into internal REPL messages and explicitly ignores unsupported or UI-irrelevant message types.
- `../agentic-code/src/utils/messages.ts` contains normalization, tool-result pairing, provider-facing conversion, and transcript-facing helpers.

What likely had to exist before it: scalar IDs, message roles/types, tool-use/tool-result model, system/attachment/progress distinction.

What depends on it: provider adapter, replay, UI, SDK, bridge, tests, tool execution, session storage.

Smallest useful turnturn version: one protocol package with enum-backed command/event/message types, Zod schemas, and canonical-to-provider projection.

Risk if late: engine internals leak renderer/provider objects and become expensive to serialize later.

Risk if early: over-modeling every future message category before real loop pressure exists.

Recommendation: copy the idea of pure message contracts and generated/runtime schemas; reject the degree of Anthropic-specific shape in core contracts.

### 3. Tool contract and permission context before the model loop

Why foundational: the agent loop cannot be correct unless tool schema, validation, permission, rendering/progress, result mapping, cancellation, and concurrency safety are known at the tool boundary.

Evidence:
- `../agentic-code/prompts/00-overview.md` places tool-system audit before query-engine work.
- `../agentic-code/src/Tool.ts` makes each tool carry `inputSchema`, `validateInput`, `checkPermissions`, `call`, `mapToolResultToToolResultBlockParam`, `isReadOnly`, `isConcurrencySafe`, `interruptBehavior`, prompt contribution, and renderer hooks.
- `../agentic-code/src/services/tools/toolExecution.ts` validates with Zod, runs pre-tool hooks, resolves permissions, emits telemetry spans, calls the tool, maps model-visible tool results, and runs post-tool hooks.
- `../agentic-code/src/services/tools/toolOrchestration.ts` partitions tools into serial or concurrent batches based on `isConcurrencySafe`.

What likely had to exist before it: tool definition type, tool registry, permission result type, execution context, abort signal convention.

What depends on it: real provider tool calls, approval UX, provider-history validity, telemetry, cancellation, parallelism.

Smallest useful turnturn version: three or four core tools, Zod input schemas, permission result enum, explicit model-visible result mapping, per-tool abort signal, and read-only/concurrency metadata even if execution starts sequential.

Risk if late: the engine gets built around "just call a function" and later cannot express approval, denial, safe failure, or provider-visible synthetic results cleanly.

Risk if early: building a large tool catalog before the loop works will create integration noise.

Recommendation: adapt the full contract shape early with a tiny tool set.

### 4. Context construction and prompt layering before real provider calls

Why foundational: `agentic-code` does not send raw chat history alone; each call combines system prompt, user context, system context, tools, memory, MCP state, model settings, and feature-dependent prompt fragments.

Evidence:
- `../agentic-code/src/QueryEngine.ts` calls `fetchSystemPromptParts`, builds `userContext`, optionally loads memory mechanics, appends custom prompts, and registers structured-output enforcement before processing the user input.
- `../agentic-code/src/query.ts` applies memory prefetch, skill discovery prefetch, context collapse, microcompact, autocompact, tool result budgeting, user/system context injection, and tool schema filtering before `deps.callModel`.
- `../agentic-code/prompts/10-context-and-prompts.md` treats system prompt, dynamic context, memory, and tool descriptions as a separate build stage.

What likely had to exist before it: config/auth, tool registry, message history shape, workspace/project identity.

What depends on it: provider requests, compaction, memory, tool visibility, model correctness, prompt caching.

Smallest useful turnturn version: deterministic context builder that takes session, workspace, tools, history, and model config and returns a provider-neutral request context.

Risk if late: provider adapters silently own context decisions, making behavior inconsistent across providers.

Risk if early: building memory/compaction before there is enough history to stress them.

Recommendation: copy explicit context construction; defer advanced compaction/memory, but reserve the boundary now.

### 5. Provider call boundary with streaming and injectable dependencies

Why foundational: a coding assistant lives on streaming events, partial tool calls, provider errors, retry/fallback, token accounting, and request IDs.

Evidence:
- `../agentic-code/src/query/deps.ts` defines an injectable `callModel` dependency plus compaction and UUID hooks, explicitly to make tests easier.
- `../agentic-code/src/services/api/claude.ts` owns Anthropic-specific request construction, headers, betas, retries, streaming cleanup, idle watchdogs, non-streaming fallback, and provider message normalization.
- `../agentic-code/src/query.ts` consumes `deps.callModel` as an async stream and treats tool-use blocks as the loop-continuation signal.

What likely had to exist before it: canonical messages, tool contracts, auth/config, context builder.

What depends on it: real agent loop, streaming UI, tool invocation, observability, retry handling.

Smallest useful turnturn version: provider port that streams provider-neutral assistant deltas/tool requests/final state, plus one real adapter and one fake/recorded adapter for tests.

Risk if late: the engine becomes provider-native and hard to make multi-provider.

Risk if early: forcing OpenAI/Gemini parity before one loop works may overfit abstractions.

Recommendation: adapt the injectable dependency pattern, but make the provider port more explicit than `agentic-code` does.

### 6. Query/agent loop after tools, context, provider, and storage contracts

Why foundational: the loop is where all earlier foundations are composed; in `agentic-code`, it is not a standalone "while model asks tool" function.

Evidence:
- `../agentic-code/src/QueryEngine.ts` owns one conversation, keeps mutable messages across turns, processes user input, records transcript before provider response, yields SDK messages, and wraps permission denials for SDK reporting.
- `../agentic-code/src/query.ts` is the iterative loop: prepare context, call model, collect assistant/tool-use blocks, execute tools, append tool results, continue, recover from prompt/model errors, and terminate.
- `../agentic-code/src/query/config.ts` snapshots runtime gates once per query and comments that separating config from mutable state makes future step extraction tractable.

What likely had to exist before it: message contracts, tool contract, provider call boundary, context construction, session identity, transcript writer.

What depends on it: CLI/SDK execution, background tasks, bridge sessions, subagents, replay/debugging.

Smallest useful turnturn version: a local sequential engine that accepts serialized commands, creates conversation/session before turn, calls a real provider adapter, executes one tool, returns tool result to provider, completes the turn, and emits durable records/live events.

Risk if late: nothing proves the product spine.

Risk if early: if built before context/session/tool/permission contracts, it becomes callback-shaped and hard to transport.

Recommendation: adapt the loop shape but keep turnturn's engine transport-neutral and durable-event-first.

### 7. Persistence/resume alongside the loop, not after UI

Why foundational: `agentic-code` makes resume survivability part of the query path, including writing the user message before the provider responds.

Evidence:
- `../agentic-code/src/QueryEngine.ts` records the accepted user message before entering the query loop so resume works if the process dies before an API response.
- `../agentic-code/src/utils/sessionStorage.ts` stores per-session JSONL transcripts, assigns parent chains, excludes ephemeral progress from transcript participation, supports sidechain agent transcripts, metadata entries, compaction boundaries, title/tag/session metadata, and large-file loading shortcuts.
- `../agentic-code/src/assistant/sessionHistory.ts` pages remote session events by cursor.
- `../agentic-code/src/entrypoints/agentSdkTypes.ts` exposes session listing, session info, messages, rename, tag, fork, create, and resume APIs as unstable v2 SDK shape.

What likely had to exist before it: session ID, message/event shape, append-only storage format, replay rules.

What depends on it: resume, branch/fork, background tasks, bridge, SDK, observability, reliable crash recovery.

Smallest useful turnturn version: durable append-only event log with record IDs/sequences, explicit durable-vs-live distinction, replay reducers, and early write of accepted user input.

Risk if late: restart/reconnect semantics become a retrofit over in-memory arrays.

Risk if early: implementing branch/fork/metadata/compaction before the first loop works.

Recommendation: copy the principle of persistence in the critical path; reject copying the complex parentUuid transcript model wholesale if turnturn already has ordered durable records.

### 8. Permission suspension/resolution as a runtime boundary

Why foundational: approvals race with hooks, classifiers, local UI, bridge UI, channels, aborts, and worker agents. `agentic-code` had to make this a first-class coordination point.

Evidence:
- `../agentic-code/src/hooks/useCanUseTool.tsx` builds a `CanUseToolFn` that returns a `PermissionDecision` and routes allow/deny/ask through config, hooks, classifiers, swarm worker handling, bridge callbacks, and interactive prompts.
- `../agentic-code/src/hooks/toolPermission/PermissionContext.ts` creates queue operations, logging, permission persistence, abort resolution, and `createResolveOnce` to prevent double resolution.
- `../agentic-code/src/hooks/toolPermission/handlers/interactiveHandler.ts` races local user interaction, bridge responses, channel responses, hooks, classifier checks, and aborts.
- `../agentic-code/src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` forwards worker permission requests to a leader via mailbox.

What likely had to exist before it: tool contract, permission result schema, app/session state, abort signal, UI/bridge callback hooks.

What depends on it: destructive tools, remote/IDE approval, worker/subagent approval, cancellation, audit logs.

Smallest useful turnturn version: approval-request record, approval-resolve command, suspended turn/tool state, single-resolution guard, and synthetic denied/aborted tool result generation.

Risk if late: approval becomes callback ownership and blocks transport/reconnect.

Risk if early: building classifiers/channel relays before local approval works.

Recommendation: adapt the state machine, not the UI callback implementation. Use serialized approvals earlier than `agentic-code` appears to.

### 9. Tool-result pairing and synthetic-result policy before provider adapters are trusted

Why foundational: provider APIs reject malformed tool-use histories; repairs can keep sessions alive but can also poison training/evaluation data.

Evidence:
- `../agentic-code/src/query.ts` emits synthetic tool results for missing tool-use results on query errors, fallback, streaming abort, and tool abort.
- `../agentic-code/src/services/tools/StreamingToolExecutor.ts` creates synthetic error tool results for sibling errors, user interruption, and streaming fallback while preserving output order.
- `../agentic-code/src/services/api/claude.ts` calls `ensureToolResultPairing` after normalizing messages and before provider submission.
- `../agentic-code/src/utils/messages.ts` defines `SYNTHETIC_TOOL_RESULT_PLACEHOLDER` and `ensureToolResultPairing`; strict mode throws instead of repairing when synthetic placeholders would be unacceptable.

What likely had to exist before it: tool-use IDs, assistant/user message pairing, durable history/replay, provider request builder.

What depends on it: provider adapter reliability, replay, resume, evaluation/training safety.

Smallest useful turnturn version: provider-history validator that enforces one terminal result per tool request, distinguishes real versus synthetic results, and fails or repairs according to mode.

Risk if late: real provider smoke tests pass in simple cases but fail on interruption/resume/error paths.

Risk if early: building every provider's exact validation rules before one adapter exists.

Recommendation: copy the invariant; adapt repair policy to turnturn's durable event model. Do not silently synthesize without marking it.

### 10. Observability built into the runtime path

Why foundational: the difficult bugs in `agentic-code` are lifecycle, streaming, replay, cache, and permission timing bugs; those require IDs, spans, checkpoints, and durable diagnostics.

Evidence:
- `../agentic-code/src/query.ts` uses `queryCheckpoint`, `logEvent`, query chain IDs, query depth, transition reasons, and API/tool phase markers.
- `../agentic-code/src/utils/queryProfiler.ts` enumerates a detailed query timeline from input receipt through context loading, model call, streaming, tool execution, and query end.
- `../agentic-code/src/services/tools/toolExecution.ts` emits tool spans, blocked-on-user spans, tool-result events, permission decision metadata, duration metrics, and sanitized error categories.
- `../agentic-code/src/bootstrap/state.ts` stores prompt IDs, last request IDs, model usage, cost, API duration, tool duration, classifier duration, and in-memory error logs.

What likely had to exist before it: session/turn/tool/request IDs and consistent event boundaries.

What depends on it: debugging, replay validation, reliability work, user handoff, remote/session support.

Smallest useful turnturn version: trace IDs for command/session/turn/provider-step/tool/approval, structured lifecycle events, phase timings, and replay validation reports.

Risk if late: architecture mistakes are invisible until complex failures.

Risk if early: telemetry vendor integration and analytics taxonomy can distract from harness behavior.

Recommendation: adapt local structured tracing first; defer external telemetry sinks.

### 11. Renderer, SDK, bridge, and remote sessions as consumers after the core loop

Why foundational: `agentic-code` has terminal UI, SDK, bridge, remote sessions, and web/IDE paths, but bridge is optional and heavily gated.

Evidence:
- `../agentic-code/docs/bridge.md` describes two transport generations and explicitly says bridge functionality can be deferred behind `BRIDGE_MODE`.
- `../agentic-code/src/remote/RemoteSessionManager.ts` manages WebSocket messages, HTTP sends, permission control requests/responses, reconnect, and cancel for remote sessions.
- `../agentic-code/src/remote/sdkMessageAdapter.ts` converts between SDK and internal display messages and gracefully ignores unknown types.
- `../agentic-code/src/bridge/replBridge.ts` and `../agentic-code/src/bridge/initReplBridge.ts` attach bridge behavior to an existing REPL/session rather than defining the engine itself.

What likely had to exist before it: session identity, canonical messages/SDK events, permission protocol, engine loop, persistence.

What depends on it: IDE/web UI, remote control, reconnect, multi-session UX.

Smallest useful turnturn version: local renderer subscribes to live events; no remote transport required, but command/event serialization must be the same boundary future transports will use.

Risk if late: if core loop used callbacks/shared memory, transport becomes expensive.

Risk if early: bridge/auth/session-ingress complexity can dominate before the assistant works.

Recommendation: copy feature-gated transport architecture; defer remote bridge implementation while testing the core through serialized command/event boundaries.

### 12. Tasks/subagents/worktrees after the main runtime works

Why foundational: `agentic-code` treats background sessions, agents, swarms, worktrees, and remote agents as serious subsystems with their own transcripts, permissions, tools, and lifecycle.

Evidence:
- `../agentic-code/src/Task.ts` defines task types/statuses, terminal-state checks, task IDs, and task state.
- `../agentic-code/src/tasks/LocalMainSessionTask.ts` backgrounds the main query into an isolated transcript path to avoid corrupting the active session after `/clear`.
- `../agentic-code/src/tools/AgentTool/AgentTool.tsx` defines subagent schema, model override, permission mode, backgrounding, worktree isolation, remote launching, and progress output.
- `../agentic-code/src/tools/AgentTool/runAgent.ts` constructs agent-specific context, tools, MCP servers, permission context, transcript sidechains, worktree metadata, and query execution.

What likely had to exist before it: query loop, tool execution, permission context, persistence, task output paths, context builder.

What depends on it: multi-agent exploration, background tasks, delegation, remote work.

Smallest useful turnturn version: none in the first real-provider loop; later add local subagent as another engine session with scoped tools and isolated persistence.

Risk if late: if not considered, main engine may not support nested sessions or scoped permissions.

Risk if early: subagents multiply every unfinished core problem.

Recommendation: investigate and reserve IDs/parentage/scoped permissions now; implement after the main loop is stable.

## 2. Evidence map with file/module references

- `../agentic-code/prompts/00-overview.md`: staged build order; notably tools before query engine, bridge after query engine, testing last.
- `../agentic-code/prompts/07-tool-system.md`: tool audit is treated as prerequisite to core loop.
- `../agentic-code/prompts/09-query-engine.md`: query engine depends on API client, tool definitions, registry, context, prompts, token utilities, and streaming.
- `../agentic-code/prompts/10-context-and-prompts.md`: system prompt, context gathering, memory, and tool descriptions are their own construction stage.
- `../agentic-code/prompts/12-services-layer.md`: analytics, policy, settings, session memory, bootstrap, and cost tracking must fail gracefully.
- `../agentic-code/prompts/13-bridge-ide.md`: bridge is explicitly deferrable if feature-gated and stubbed.
- `../agentic-code/src/QueryEngine.ts`: one engine per conversation; mutable messages persist across turns; user input is recorded before provider response; SDK messages are yielded.
- `../agentic-code/src/query.ts`: iterative provider/tool loop, compaction, context building, streaming, fallback, synthetic missing tool results, stop hooks, and tool execution.
- `../agentic-code/src/query/deps.ts`: narrow dependency injection for provider/model call and compaction tests.
- `../agentic-code/src/query/config.ts`: query-time runtime gates snapshotted as plain data to make future state-step extraction possible.
- `../agentic-code/src/Tool.ts`: tool contract includes schemas, permissions, execution, result mapping, UI, concurrency safety, and interrupt behavior.
- `../agentic-code/src/services/tools/toolExecution.ts`: Zod validation, hooks, permissions, tool call, model-visible result mapping, telemetry, error handling.
- `../agentic-code/src/services/tools/toolOrchestration.ts`: serial/concurrent partitioning from tool metadata.
- `../agentic-code/src/services/tools/StreamingToolExecutor.ts`: streaming-time execution, ordering, sibling cancellation, child abort controllers, synthetic results.
- `../agentic-code/src/hooks/toolPermission/PermissionContext.ts`: permission queue, persistence, abort handling, single-resolution guard.
- `../agentic-code/src/hooks/toolPermission/handlers/interactiveHandler.ts`: local, bridge, channel, hook, classifier, and abort races.
- `../agentic-code/src/hooks/toolPermission/handlers/coordinatorHandler.ts`: background/coordinator automated checks before user dialog.
- `../agentic-code/src/hooks/toolPermission/handlers/swarmWorkerHandler.ts`: worker permission request forwarded to leader.
- `../agentic-code/src/types/message.ts`: pure message discriminated unions.
- `../agentic-code/src/utils/messages.ts`: normalization, provider-facing pairing repair, synthetic missing result marker, message relationship lookups.
- `../agentic-code/src/services/api/client.ts`: provider/auth/client construction.
- `../agentic-code/src/services/api/claude.ts`: Anthropic-specific provider request/stream/retry/normalization layer.
- `../agentic-code/src/bootstrap/state.ts`: session, project, telemetry, strict pairing, cache, model, auth, and feature state.
- `../agentic-code/src/utils/sessionStorage.ts`: JSONL transcript, parent chains, metadata entries, sidechain agents, compaction/load optimizations, resume/fork support.
- `../agentic-code/src/assistant/sessionHistory.ts`: remote paged history.
- `../agentic-code/src/remote/sdkMessageAdapter.ts`: SDK-to-renderer adaptation and unknown message tolerance.
- `../agentic-code/src/remote/RemoteSessionManager.ts`: remote session protocol, permission control requests, cancellation, reconnect.
- `../agentic-code/src/Task.ts`: task lifecycle shape.
- `../agentic-code/src/tasks/LocalMainSessionTask.ts`: main session backgrounding with isolated transcript output.
- `../agentic-code/src/tools/AgentTool/AgentTool.tsx` and `../agentic-code/src/tools/AgentTool/runAgent.ts`: subagent/task/worktree/runtime inheritance.

## 3. Expensive-to-reverse decisions

- Core history shape: if provider-native messages become the source of truth, multi-provider adapters and replay become hard.
- Session identity and persistence timing: if accepted user input is not durable before provider work, resume-after-crash becomes unreliable.
- Tool boundary: if tools are plain functions, permission, abort, progress, result mapping, and concurrency metadata become retrofits.
- Approval ownership: if approval is a UI callback, bridge/remote/subagent approval needs race-prone adapters.
- Tool-result pairing: if not enforced before provider submission, resume/interruption paths create provider 400s or fake unmarked history.
- Durable versus ephemeral events: persisting progress/noise pollutes replay; omitting important facts breaks recovery.
- Context construction: if each provider adapter builds its own context, prompt/memory/tool visibility drift across providers.
- Observability IDs: if trace IDs are not part of command/turn/step/tool/approval boundaries, later debugging cannot correlate failures.
- Transport boundary: if engine assumes local callbacks/shared memory, remote session support becomes architectural surgery.
- Subagent parentage and scoped permissions: if ignored, later agents inherit too much authority or corrupt parent session history.

## 4. Things agentic-code suggests can be fake/local/simple early

- Bridge/remote control can be off behind a feature gate if the local loop already emits/consumes serializable messages.
- External telemetry sinks can be stubbed; keep local structured spans/events.
- OAuth/enterprise/provider matrix can be narrow; start with one credential path.
- Large tool catalog can be small; keep the rich tool contract with a tiny set of tools.
- Parallel tool execution can start as sequential; keep concurrency metadata and same-response tool ordering.
- Compaction/memory can be minimal; reserve context-builder boundaries.
- Subagents and background tasks can be deferred; reserve session parentage, scoped tools, and isolated persistence concepts.
- Real provider tests should be smoke-level; deterministic or recorded provider tests remain useful for contract/failure coverage.

## 5. Suspicious assumptions in turnturn's current roadmap

- "Agent loop" as the next center may still be too narrow. `agentic-code` implies runtime boot, tool contract, context construction, provider boundary, persistence timing, and permission suspension must shape the loop first.
- "Real provider adapters now" is only safe if a provider-neutral port already exists. `agentic-code` is deeply Anthropic-shaped, which is useful but also a warning.
- "Provider-history reducer now, validator later" is risky. `agentic-code` repairs pairing immediately before provider submission and has strict mode because malformed/synthetic history has real consequences.
- "Sequential execution means simple scheduler" is incomplete. Even sequential v1 must preserve multiple tool calls emitted by one provider response, terminal result pairing, abort behavior, and sibling error semantics.
- "Session creation belongs to a later server milestone" is wrong. `agentic-code` makes session ID and transcript path foundational before query execution.
- "Transport can be entirely later" is only partly true. Bridge implementation can wait, but command/event/message serialization cannot.
- "Persistence after engine" is backwards for crash/replay safety. Accepted user input and key state transitions must be written during the loop.
- "Subagents later means no design now" is unsafe. Implementation can wait, but parent/child session identity, scoped permissions, and sidechain transcript implications should be reserved.

## 6. Questions the synthesis agent must resolve

- Should turnturn split the next work into "runtime foundation" and "real-provider sequential loop" rather than one milestone?
- Which provider should be first, and what is the smallest provider-neutral stream event contract that does not overfit it?
- What minimal context builder must exist before the first real provider call?
- Which three or four tools are sufficient to prove the coding harness without building a catalog?
- Should provider-history validation move earlier, before or inside the first provider adapter?
- What exact durable records must be appended before, during, and after a turn to guarantee resume after crash?
- How should approval suspension be represented so local UI, future remote UI, and subagents share one path?
- What events are durable facts versus live-only progress?
- What same-response multi-tool ordering invariant must v1 preserve even if execution is sequential?
- What should happen when a tool fails, a permission is denied, a turn is cancelled, or provider streaming fails after emitting tool calls?
- What trace/span IDs are mandatory in v1 for command/session/turn/provider/tool/approval debugging?
- How much of task/subagent parentage should be reserved in protocol now without implementing subagents?
