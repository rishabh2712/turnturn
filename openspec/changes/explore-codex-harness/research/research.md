# Codex Harness vs Turnturn: Mechanisms to Understand

Date: 2026-09-23. Local Codex snapshot: `../codex` at `73a1148c9c775c2a4616ce5096291740a00ed68a`. Turnturn: `fc383b2de95431c4f4e4913233cf5ed61fa3156b` plus the working tree on `codex/product-grade-coding-workspace`; the OpenSpec closure and parallel-tools draft were uncommitted, so inspect the working tree as well as HEAD. Source links below are relative to the Turnturn repository. The [official Codex harness overview](https://developers.openai.com/blog/codex-as-a-platform) describes the loop, context, tools, policy, and continuation at the product level; the local source establishes the specific mechanisms compared here.

**Method and limit.** This is a source inspection of two different harnesses. An observed mechanism is not proof that it improves task success. Codex may also use a different model, model configuration, or provider feature. We have not run controlled same-model tasks. Each “effect” below is a hypothesis to test, not a measured win. Turnturn's existing durable log, provider adapters, policy gate, approvals, tests, and observability are real capabilities, not placeholders.

## One coding turn, compared

```text
Codex: task + instructions + repo/environment context + selected tools + managed history
       → model → tool dispatch/runtime → bounded result → next context → model

Turnturn: user input + durable provider history + six tool definitions
          → model → collect step → sequential tool calls → results → next history → model
```

This is a map of the inspected paths, not a complete feature list. Turnturn records its turn through an append-only session log and can expose detailed traces. Codex also has orchestration outside the simple loop: model-request retries, tool concurrency, long-lived processes, context compaction, instruction loading, and user input during a running turn.

## 1. Instructions and repository context

**Codex observed.** [`agents_md.rs`](../../../../../codex/codex-rs/core/src/agents_md.rs) finds instructions from project root to working directory and bounds their size. [`session/mod.rs`](../../../../../codex/codex-rs/core/src/session/mod.rs) assembles developer sections, loaded plugins, extension contributions, and contextual user sections before model calls; `build_initial_context_with_world_state` is the entry to inspect. [`ext/skills/src/render.rs`](../../../../../codex/codex-rs/ext/skills/src/render.rs) budgets and renders available skill metadata. These are paths for giving the model task rules and relevant capabilities, not just storing them on disk.

**Turnturn observed.** [`ProviderStepRunner.run`](../../../../packages/assistant-core/src/provider-step-runner.ts) builds a request from `reduceProviderHistory(sessionRecords)` and `tools.definitions()`. Its `modelContextSnapshot` explicitly marks system, developer, and workspace instructions `unavailable` with “not wired.” The [`discoverAgentsMd` helper](../../../../packages/assistant-core/src/workspace/instructions.ts) exists and is tested but is not called by the model-request path. Both current [OpenAI chat request](../../../../packages/assistant-core/src/providers/openai-chat-completions/request.ts) and [Anthropic request](../../../../packages/assistant-core/src/providers/anthropic-messages/request.ts) serialize history and tools without adding instruction content.

**Effect to test.** On a fresh repository task, does explicitly supplying scoped repository instructions and agent operating rules change tool choice, edits, and verification? The current context inspector can show the absence; it does not select or inject contributions. **Decision question:** Should a provider-neutral context assembler own selected instructions before the adapter translates them into wire-specific roles, and how do nested file instructions enter when work moves across directories?

## 2. Context budget and continuation

**Codex observed.** [`context_manager/history.rs`](../../../../../codex/codex-rs/core/src/context_manager/history.rs) normalizes model-visible items, truncates function outputs, and estimates tokens. [`session/turn.rs`](../../../../../codex/codex-rs/core/src/session/turn.rs) checks post-response token status and may run compaction before continuing. Codex's model/API integration can also carry provider-specific compaction state; the [official compaction guide](https://developers.openai.com/api/docs/guides/compaction) explains that path. The local implementation has several compaction variants, so we should not assume one applies to every provider.

**Turnturn observed.** [`ProviderStepRunner`](../../../../packages/assistant-core/src/provider-step-runner.ts) replays all session provider history for the step. It observes `usage` events but does not feed them into a budget decision. [`context/projection.ts`](../../../../packages/assistant-core/src/context/projection.ts) estimates tokens from serialized length for diagnostics. Shell output is byte-capped, search has default result limits, but [`readTool`](../../../../packages/assistant-core/src/workspace/file-tools.ts) defaults to the entire text file and historic tool results are replayed without a context budget. The snapshot marks compaction unavailable.

**Effect to test.** Run a task whose repeated reads/searches approach a provider's window and inspect the exact next request, model response, cost, and whether useful earlier decisions survive. **Decision question:** What provider-neutral budget and compaction record can be replayed from durable history, and where may an adapter use provider-specific continuation without changing the meaning of that history?

## 3. Tool dispatch and parallelism

**Codex observed.** [`tools/parallel.rs`](../../../../../codex/codex-rs/core/src/tools/parallel.rs) asks the router whether a call supports parallel execution. A shared/exclusive gate lets permitted calls overlap while exclusive calls wait. [`session/turn.rs`](../../../../../codex/codex-rs/core/src/session/turn.rs) holds in-flight tool futures while processing model output and drains them before proceeding. This couples concurrency to call IDs, cancellation, runtime readiness, and result ordering, not merely to `Promise.all`.

**Turnturn observed.** [`ToolWaveRunner.run`](../../../../packages/assistant-core/src/tool-wave-runner.ts) validates, decides policy, persists the request, resolves approval/execution, and writes the result before handling the next call. Tool definitions already expose `mutating`. The separate [parallel-tool-waves design](../../implement-parallel-tool-waves/design.md) proposes bounded overlap for built-in read/search tools and ordered durable results; that design is awaiting review. It deliberately covers less than Codex's full scheduler.

**Effect to test.** Hold two independent reads behind barriers: prove execution overlaps and both results replay in provider order; compare latency with the sequential baseline. **Decision question:** Is this bounded first wave enough for now, and what evidence would justify dispatch during provider streaming or parallel custom tools later?

## 4. Managed shell processes

**Codex observed.** [`unified_exec/process_manager.rs`](../../../../../codex/codex-rs/core/src/unified_exec/process_manager.rs) can return an initial output snapshot while a process remains alive, then support later `write_stdin`/poll calls. The process manager retains lifecycle and output state, with cancellation and bounded output.

**Turnturn observed.** [`shellTool`](../../../../packages/assistant-core/src/workspace/shell-tool.ts) waits for `close`, then returns one tool result. It sends live output callbacks and has a timeout, but there is no model-visible process/session ID or later poll/input tool. A long-running server or watch command therefore does not become an ongoing tool conversation. This is separate from web UI streaming: the model receives its completed tool result only at process exit.

**Effect to test.** Start a build or dev server, inspect output, then run another command while it is alive. **Decision question:** Do we want durable process identities and recovery semantics, or only bounded foreground commands plus a separate background-execution feature?

## 5. Editing and verification

**Codex observed.** [`apply-patch`](../../../../../codex/codex-rs/apply-patch/src/seek_sequence.rs) represents contextual patches; its matching has exact and progressively looser passes. [`tools/handlers/apply_patch.rs`](../../../../../codex/codex-rs/core/src/tools/handlers/apply_patch.rs) routes patch application through runtime policy and reports file-change information. Rich matching can reduce failed edits, but the source inspection does not prove atomic rollback for a multi-file patch.

**Turnturn observed.** [`editTool`](../../../../packages/assistant-core/src/workspace/file-tools.ts) reads a file, counts exact `oldText` occurrences, replaces, and writes. Ambiguous/missing matches produce recoverable codes. `writeTool` and `editTool` write directly; a diff shown afterward is an applied change. The roadmap's pre-apply review and more reliable matching remain future work.

**Effect to test.** Use the same model on real edits with shifted whitespace, repeated blocks, line-ending differences, and multi-file changes; measure first-attempt application, wrong-location edits, and recovery. **Decision question:** What edit representation and verification guarantee do we want before broadening matching?

## 6. Failure recovery and user steering

**Codex observed.** [`responses_retry.rs`](../../../../../codex/codex-rs/core/src/responses_retry.rs) retries selected sampling failures with backoff, can notify the UI about reconnection, and has a transport fallback in supported configurations. [`session/turn.rs`](../../../../../codex/codex-rs/core/src/session/turn.rs) checks an input queue and can incorporate pending user input as the task continues. These behaviors have model/provider-dependent conditions.

**Turnturn observed.** Adapters classify some HTTP/stream failures as retryable, but [`ProviderStepRunner`](../../../../packages/assistant-core/src/provider-step-runner.ts) writes `provider.step.failed` and throws on a failed event; it has no retry loop. The user can cancel a turn, and session storage repairs interrupted turns on restart, but those actions do not resume the in-flight work. The command surface has no mid-turn steering operation.

**Effect to test.** Inject a transient failure before any provider output, and separately send a user correction while a tool is running. Observe whether the task continues without duplicate tool execution. **Decision question:** Define retry-before-output, mid-stream recovery, user steering, and restart recovery as separate behaviors; which one is needed first?

## 7. Permission and execution boundary

**Codex observed.** [`tools/orchestrator.rs`](../../../../../codex/codex-rs/core/src/tools/orchestrator.rs) coordinates approval, sandbox selection, and retry/escalation paths around runtimes. It can enforce scoped execution while avoiding approval for every permitted action; the exact policy varies by host and configuration.

**Turnturn observed.** [`LocalToolPolicy`](../../../../packages/assistant-server/src/policy.ts) asks for approval for shell/write/edit by default. [`WorkspacePathGuard`](../../../../packages/assistant-core/src/workspace/path-guard.ts) confines file tools and shell cwd, while a shell command itself is unconfined. [`shellTool`](../../../../packages/assistant-core/src/workspace/shell-tool.ts) calls `spawn` without `env`, so it inherits the server process environment by Node's documented default. Path checks and approval are useful, but they do not impose an OS sandbox.

**Effect to test.** In a disposable workspace, test allowed/denied actions, out-of-root attempts, and whether a policy can let routine safe work proceed without prompting on every call. **Decision question:** What containment and environment isolation must be implemented before persistent allow rules or broader unattended work?

## 8. Skills and cross-session memory

**Codex observed.** [`ext/skills/src/render.rs`](../../../../../codex/codex-rs/ext/skills/src/render.rs) budgets a discoverable skill catalog; loading a skill supplies task-specific guidance. [`memories/README.md`](../../../../../codex/codex-rs/memories/README.md) describes a separate, gated pipeline for extracting and consolidating reusable memory. That pipeline is more than replaying prior chat transcripts.

**Turnturn observed.** Repository `.agents/skills/` guides the agents *developing* Turnturn. The runtime model's context snapshot marks memory unavailable, and its provider request does not discover or load a model-visible skill. The durable session log provides same-session history, not curated cross-session recall.

**Effect to test.** Repeat related tasks in separate conversations and check whether retained decisions help without leaking stale or unrelated facts. **Decision question:** After context budgeting, what provenance, retention, selection, and user controls would make memory trustworthy? Skills can be discussed separately from memory.

## How to test claims of improvement

Use the same provider wire, model, repository snapshot, prompt, and tool permissions for both harnesses where possible. Record initial context, model-visible tool calls/results, edits, test outcomes, turn duration, tokens/cost, approvals, and failures. Run at least the cases below before saying an adopted mechanism improves quality:

| Case | What it probes |
| --- | --- |
| Fresh repo with `AGENTS.md` rule | Instruction selection and adherence |
| Two independent reads plus an edit | Parallel admission and ordering |
| Noisy search then multi-step edit | Output bounding and context continuity |
| Long build or dev server | Process lifecycle |
| Shifted/repeated edit target | Application accuracy and recovery |
| Transient provider failure | Retry without duplicate action |
| User correction during execution | Steering semantics |
| Related tasks in two conversations | Memory relevance and provenance |

Codex and Turnturn do not expose exactly the same provider wires or tool affordances, so comparisons must record these differences. The present findings are code-backed hypotheses and decision prompts. `design.md` will hold the choices after discussion; the roadmap remains the owner of ordering.
