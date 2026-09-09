# Construction Order Meta-Research

Question: if building a coding assistant from scratch, what should be baked into the architecture, in what order, and why?

This document treats the reference implementations as evidence, not as templates to copy wholesale. The durable lesson is that the user-visible assistant loop is a late expression of earlier contracts: causal protocol, replayable history, policy/tool lifecycle, and model-context construction.

## 1. Recommended Construction Order

### 1. Canonical conversation protocol and causal IDs

Why foundational: every later layer needs stable names for the same facts: conversation, session, turn, provider step, tool call, approval, durable record, and live event. If those identities are added after tools or UI exist, every boundary grows compatibility glue.

Evidence: Codex's protocol crate defines a submission queue/event queue boundary, correlates every `Event` to a submission id, and carries turn/root/parent causality through `Submission` (`../codex/codex-rs/protocol/src/protocol.rs`). turnturn already has branded IDs and scoped records in `packages/protocol/src/index.ts`, which is the right kind of foundation.

Before it: only product invariants and a small JSON value model.

After it: append-only history and a reducer that can replay the protocol without a provider or UI.

Smallest useful first version: `CommandEnvelope`, `DurableRecord`, `LiveEvent`, branded IDs, sequence numbers assigned by the sink, and enough command types for create session, submit turn, resolve approval, cancel turn, and cancel tool.

Risk of adding too late: tool calls, approvals, and UI events end up identified by provider-native IDs or callback references, making resume, transport, and auditability expensive to retrofit.

Risk of adding too early: over-modeling future objects such as remotes, subagents, memory, or worktrees before their lifecycle is understood.

### 2. Append-only durable log plus pure replay reducers

Why foundational: serious assistants must survive process death, cancellation, compaction, and UI refresh. The durable log should store completed facts; live events should be a projection, not the source of truth.

Evidence: agentic-code writes user messages to transcript before entering the model loop so a killed process remains resumable (`../agentic-code/src/QueryEngine.ts`, `../agentic-code/src/utils/sessionStorage.ts`). It also distinguishes transcript messages from ephemeral progress because persisting progress previously broke resume chains. Gemini CLI has a `chatRecordingService` that loads JSONL incrementally, supports rewind records, metadata updates, and resumable-content filtering (`../gemini-cli/packages/core/src/services/chatRecordingService.ts`). Codex separates durable protocol events from richer streaming/lifecycle events in `EventMsg`.

Before it: canonical protocol and IDs.

After it: engine state reducer, provider-history reducer, and live-event projection.

Smallest useful first version: an in-memory append-only sink in tests, a JSONL-compatible interface, monotonic `sequence`, and reducers for engine state and provider history. File persistence can wait; the append contract cannot.

Risk of adding too late: each subsystem invents its own state store; replay correctness becomes archaeology.

Risk of adding too early: building a production database, indexing, search, or retention system before the durable record shape has been exercised.

### 3. Provider-independent model context and response normalization

Why foundational: the assistant loop must not persist provider SDK objects or expose provider quirks to tools, policy, or UI. The expensive decision is where provider-native content is normalized into assistant text, tool requests, stop reasons, raw diagnostics, and usage.

Evidence: Gemini's `Turn.run` wraps `sendMessageStream` and yields a simpler event union: content, thought, tool-call request, confirmation, errors, retry, compression, and finished (`../gemini-cli/packages/core/src/core/turn.ts`). Codex converts provider `ResponseItem`s into internal `ToolCall`s through `ToolRouter::build_tool_call` (`../codex/codex-rs/core/src/tools/router.rs`). agentic-code has SDK message adapters for remote sessions and normalizes provider messages before rendering (`../agentic-code/src/remote/sdkMessageAdapter.ts`).

Before it: durable records and reducers, so normalization has somewhere stable to land.

After it: scripted provider, then real provider adapters.

Smallest useful first version: a scripted provider that emits normalized assistant chunks, completed assistant messages, tool requests, stop reasons, and recoverable provider errors. Keep provider raw payloads optional and diagnostic-only.

Risk of adding too late: provider formats leak into durable history, making multi-provider support and replay brittle.

Risk of adding too early: spending time on real API retries, auth recovery, model routing, citations, and multimodal details before the normalized loop is proven.

### 4. Tool registry and canonical tool-call/result lifecycle

Why foundational: tools are the first place model output becomes side effect. The architecture must guarantee every accepted tool request reaches exactly one terminal result, and that result is model-visible when the provider needs it.

Evidence: Gemini has explicit tool-call statuses (`validating`, `scheduled`, `awaiting_approval`, `executing`, terminal states) and a scheduler that validates, checks hooks/policy, confirms, executes, and finalizes (`../gemini-cli/packages/core/src/scheduler/types.ts`, `../gemini-cli/packages/core/src/scheduler/scheduler.ts`). Codex has a `ToolRouter` separating advertised specs from executable runtimes and a lifecycle module for tool start/result/finish contributors (`../codex/codex-rs/core/src/tools/router.rs`, `../codex/codex-rs/core/src/tools/lifecycle.rs`). agentic-code partitions tool calls into serial and concurrency-safe batches, but still routes all calls through `runToolUse` and returns tool-result messages (`../agentic-code/src/services/tools/toolOrchestration.ts`).

Before it: provider-independent tool request shape.

After it: policy and approvals, then actual shell/file tools.

Smallest useful first version: one fake deterministic tool executor, a registry keyed by canonical tool name, `tool.requested`, exactly-one terminal result records, and provider-order serial execution.

Risk of adding too late: tool results become ad hoc callbacks, making cancellation, denial, replay, and provider-history repair difficult.

Risk of adding too early: building a large tool catalog, dynamic discovery, MCP, hooks, or parallel scheduling before the terminal lifecycle is airtight.

### 5. Policy and approval as a pre-execution gate

Why foundational: permission behavior cannot be a UI feature. It is part of the engine contract because it determines whether side effects happen and what result is returned to the model.

Evidence: Codex centralizes approval, sandbox selection, retry, network approval, and approval caching in `ToolOrchestrator` (`../codex/codex-rs/core/src/tools/orchestrator.rs`) and serializes approval actions for exec, patch, MCP, network, and permission requests (`../codex/codex-rs/core/src/tools/approvals.rs`). Gemini checks policy before execution, supports allow/deny/ask, handles non-interactive constraints, and persists always-allow decisions through a message bus (`../gemini-cli/packages/core/src/scheduler/policy.ts`, `../gemini-cli/packages/core/src/policy/policy-engine.ts`). agentic-code routes all tool-use permission decisions through `CanUseToolFn` and records denials for SDK reporting (`../agentic-code/src/QueryEngine.ts`, `../agentic-code/src/hooks/useCanUseTool.tsx`).

Before it: canonical tool request shape and terminal result records.

After it: sandbox/executor implementations and cancellation races.

Smallest useful first version: `allow`, `deny`, `ask`, `abort`, and `modified input`; approval records; duplicate approval idempotency; and a non-interactive rule that cannot ask.

Risk of adding too late: unsafe behavior ships as default, and later safety work must reinterpret old tool history.

Risk of adding too early: implementing classifiers, persistent policy stores, workspace trust UX, or network policy before basic decision semantics are proven.

### 6. Cancellation, interruption, and idempotency semantics

Why foundational: a coding assistant spends much of its life between states: waiting for user approval, streaming a provider response, running a tool, or retrying after failure. These states need command semantics before concurrency or remote transport.

Evidence: Codex's protocol has explicit ops for interrupt, recover turn, suspend turn, approval responses, tool/dynamic responses, and shell command execution (`../codex/codex-rs/protocol/src/protocol.rs`). Gemini's scheduler cancels queued and active calls and finalizes terminal state (`../gemini-cli/packages/core/src/scheduler/scheduler.ts`). agentic-code backfills missing tool-result blocks on interruption/error so the provider conversation does not contain orphaned tool_use blocks (`../agentic-code/src/query.ts`).

Before it: durable log, tool lifecycle, and approval records.

After it: shell/file tools and eventually background processes.

Smallest useful first version: duplicate-command table, deterministic outcomes for cancel while awaiting approval, cancel while running tool, cancel after terminal result, and recoverable tool failure as a terminal tool result when provider history requires one.

Risk of adding too late: rare races become persisted corruption and are hard to reproduce.

Risk of adding too early: designing distributed cancellation protocols before there is one local sequential turn.

### 7. Minimal execution environment boundary

Why foundational: shell/file execution is where architecture meets the user's machine. Even a fake or local executor needs an explicit environment snapshot: cwd, workspace roots, permissions, env policy, timeout, stdout/stderr handling, and output truncation.

Evidence: Codex stores environment selections and permission profiles in protocol/session state and feeds sandbox choice from the selected environment (`../codex/codex-rs/protocol/src/protocol.rs`, `../codex/codex-rs/core/src/session/session.rs`). Gemini has sandbox managers, shell execution service, environment sanitization, and tool output truncation in `ToolExecutor` (`../gemini-cli/packages/core/src/scheduler/tool-executor.ts`). agentic-code tracks cwd, file cache, permissions, and transcript paths explicitly in `QueryEngineConfig` and `ToolUseContext` (`../agentic-code/src/QueryEngine.ts`, `../agentic-code/src/Tool.ts`).

Before it: policy decisions and tool lifecycle.

After it: real shell, file edit/apply patch, sandbox retries, and stdout/stderr live deltas.

Smallest useful first version: a local synchronous executor that records cwd, command/input, exit code, stdout, stderr, timeout/cancel metadata, and truncation metadata. The sandbox may be fake initially if permission decisions are real.

Risk of adding too late: command execution semantics leak into arbitrary tools and become impossible to sandbox consistently.

Risk of adding too early: production sandboxing across OSes can dominate the project before the loop knows what it must enforce.

### 8. Context budgeting and compaction hooks

Why foundational, but not first: context management is necessary for long sessions, but it depends on replayable history and normalized provider history. Build the extension points early; build smart compaction later.

Evidence: Codex runs pre-sampling compaction before model requests and records context updates for the exact model-visible state (`../codex/codex-rs/core/src/session/turn.rs`). Gemini emits chat-compressed/context-overflow events (`../gemini-cli/packages/core/src/core/turn.ts`). agentic-code carries compact boundary messages and transcript-preservation rules through `QueryEngine` and `sessionStorage` (`../agentic-code/src/QueryEngine.ts`, `../agentic-code/src/types/message.ts`).

Before it: replayable durable history and provider-history reconstruction.

After it: auto-compaction, summaries, retrieval, memory, and context-window policy.

Smallest useful first version: token/count budget checks, an explicit `compact_boundary`/summary durable event, and a manual compaction command that can be fake or deterministic in tests.

Risk of adding too late: long sessions cannot be resumed or summarized without losing tool-call causality.

Risk of adding too early: memory and retrieval can obscure basic loop correctness and create hidden dependencies on model quality.

### 9. UI and transport projections

Why foundational to product, but not to engine: UI, SSE/WebSocket, and remote execution should consume protocol/log projections. They should not define engine semantics.

Evidence: Codex's SQ/EQ protocol exists between clients and agent, and `EventMsg` carries renderer-ready lifecycle events without making the core a renderer (`../codex/codex-rs/protocol/src/protocol.rs`). Gemini's scheduler emits `TOOL_CALLS_UPDATE` through a message bus while core tool state remains separate (`../gemini-cli/packages/core/src/scheduler/state-manager.ts`). agentic-code adapts remote SDK messages into local display messages in `sdkMessageAdapter`, which demonstrates both the utility and cost of adapter layers (`../agentic-code/src/remote/sdkMessageAdapter.ts`).

Before it: durable/live event projections.

After it: CLI/TUI/web renderer, session browser, remote transport, and background task views.

Smallest useful first version: a test subscriber or debug printer that reads live events. No renderer callbacks inside engine code.

Risk of adding too late: hard to dogfood.

Risk of adding too early: the engine becomes shaped by UI state, leading to callback-driven semantics.

### 10. Advanced composition: parallel tools, subagents, memory, remotes, dynamic tools

Why later: these are force multipliers, not foundations. They multiply correctness requirements already established by the sequential loop.

Evidence: all references contain advanced layers, but they sit on top of earlier contracts: Codex has multi-agent handlers and dynamic/MCP tools after protocol/session/tool infrastructure; Gemini has agent schedulers, A2A, MCP, browser agents, and policy; agentic-code has subagent transcript sidecars, remote sessions, plugin loading, and compaction features. None of these are needed to prove the first serious local loop.

Before it: local loop, durable replay, policy, cancellation, and environment semantics.

After it: only product-specific orchestration.

Smallest useful first version: none in the first construction phase. Preserve causal IDs and transcript shape so these can be added without schema surgery.

Risk of adding too late: missed product differentiation after the core works.

Risk of adding too early: correctness problems become distributed systems problems before local semantics are stable.

## 2. Reference Evidence Behind That Order

- Codex prioritizes a protocol boundary: `Submission`, `Op`, and `EventMsg` define user/agent communication, not UI callbacks (`../codex/codex-rs/protocol/src/protocol.rs`).
- Codex sessions are explicitly single-active-turn and interruptible; `Session` owns event emission, active turn, input queue, services, permission profile, conversation, and history mode (`../codex/codex-rs/core/src/session/session.rs`).
- Codex `run_turn` describes the basic model loop: sample, execute function call, send output back, or record assistant message and finish (`../codex/codex-rs/core/src/session/turn.rs`).
- Codex's tool architecture separates model-visible specs from executable runtimes and supports deferred/dynamic exposure through `ToolRouter` (`../codex/codex-rs/core/src/tools/router.rs`).
- Codex's `ToolOrchestrator` centralizes approval, sandbox choice, network approval, retry, and telemetry; this argues against scattering permission decisions inside individual tools (`../codex/codex-rs/core/src/tools/orchestrator.rs`).
- Gemini's `Turn` normalizes provider streaming into a core event union before scheduler/UI consumption (`../gemini-cli/packages/core/src/core/turn.ts`).
- Gemini's scheduler is a state machine around validation, policy, confirmation, execution, terminal states, cancellation, and queueing (`../gemini-cli/packages/core/src/scheduler/scheduler.ts`, `../gemini-cli/packages/core/src/scheduler/types.ts`).
- Gemini's policy engine is rule-based and explicit about non-interactive impossibility of asking users (`../gemini-cli/packages/core/src/scheduler/policy.ts`, `../gemini-cli/packages/core/src/policy/policy-engine.ts`).
- Gemini's chat recording shows JSONL can be enough initially, but rewind/checkpoint/resumable filtering must be designed deliberately (`../gemini-cli/packages/core/src/services/chatRecordingService.ts`).
- agentic-code's `QueryEngine` proves the value of a headless engine-like API, but also shows the danger of a large loop accumulating persistence, context, permission, plugin, SDK, and UI concerns in one place (`../agentic-code/src/QueryEngine.ts`).
- agentic-code's session storage distinguishes transcript facts from ephemeral progress, a concrete warning for turnturn's durable/live split (`../agentic-code/src/utils/sessionStorage.ts`).
- agentic-code's tool orchestration adds parallel batches only after determining concurrency safety; this supports starting sequential and keeping provider order (`../agentic-code/src/services/tools/toolOrchestration.ts`).

## 3. Current Roadmap Assumptions To Question

- Question whether `conversation` and `session` both need first-class semantics in the first executable slice. The references support stable IDs, but the first local loop may only need one user-facing thread/session plus turn IDs until multiple providers, windows, or remotes exist.
- Question whether `provider.step.started/completed` should be durable from day one or initially derivable from turn/tool boundaries. It is useful for audit and replay, but it can become noise if no real provider request exists yet.
- Question whether approval is modeled too narrowly as only allow/deny. References require ask, deny, abort/cancel, modified input, non-interactive failure, and eventually persistent policy updates.
- Question whether live events should mirror durable records one-to-one. References suggest some live events are projections or ephemeral progress, and persisting them can corrupt resume semantics.
- Question whether command idempotency is scoped only by command ID. Approval/cancel races need semantic idempotency around already-terminal tool calls and turns.
- Question whether a scripted provider is merely a test fake. The references imply it is the first provider adapter and should exercise the real normalized provider contract.
- Question whether parallel same-step tools belong anywhere near the first milestone. Gemini and agentic-code both have explicit machinery for concurrency safety; it should follow, not precede, sequential correctness.
- Question whether memory, subagents, remotes, and dynamic tool discovery are roadmap foundations. They depend on the foundations above and should initially be kept out of the engine core.

## 4. Unknowns Needing Follow-Up

- What exact provider-history reducer shape will support both OpenAI-style response items and Gemini/Anthropic-style tool_use/tool_result adjacency?
- What is the minimal durable representation of partial assistant output: only completed assistant messages, or durable deltas/checkpoints for crash recovery mid-stream?
- Should `provider.step` be a durable business fact, a diagnostic fact, or a live-only event until real providers arrive?
- What policy decisions should produce model-visible synthetic tool results versus terminal turn failures?
- How should cancellation interact with in-flight provider requests once the provider is real and may have already emitted tool calls?
- What shell/file edit abstraction should be first: generic tool executor, shell-only executor, or patch-only executor?
- What replay invariant should be tested as the red line: engine-state equality, provider-history equality, live-event projection equality, or all three?

## 5. Suggested Prompts For Next Explorer Agents

- Codex explorer: "In `../codex`, trace a single regular turn from `Op::TurnInput` through `run_turn`, provider response handling, tool routing, approval, sandbox retry, durable history, and `EventMsg::TurnComplete`. Identify the smallest invariants a new assistant should copy."
- Gemini CLI explorer: "In `../gemini-cli`, trace `Turn.run` plus `Scheduler.schedule` for one response with two tool calls. Explain how provider events, scheduler statuses, policy, confirmation, cancellation, and chat recording interact."
- agentic-code explorer: "In `../agentic-code`, trace `QueryEngine.submitMessage` through `query`, `runTools`, permission decisions, transcript writes, interruption, and missing tool-result repair. Identify which concerns are foundational and which are accumulated legacy coupling."
- Provider-history explorer: "Compare Codex `ResponseItem`, Gemini `Content`/`FunctionCall`, and agentic-code Anthropic `tool_use`/`tool_result` handling. Propose a provider-neutral history format that can replay the next model request without storing SDK objects."
- Cancellation/idempotency explorer: "Across all three references, catalog every cancellation, approval, retry, and duplicate-submission edge case. Propose a minimal deterministic state machine for turnturn's first sequential engine."
