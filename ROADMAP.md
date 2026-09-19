# turnturn Roadmap

Status: root source of truth for milestones
Date: 2026-09-09

## Operating Rule

This file tracks product and architecture milestones. OpenSpec tracks implementation proposals, design details, specs, research, and tasks for each milestone.

When a milestone is completed, update this roadmap in the same change that archives or completes the corresponding OpenSpec work.

Milestones 0–2 were ordered by dependency: contracts that later work depends on had to be defined first. From Milestone 3 onward the ordering rule is **information gain** — attack the risk whose resolution most changes later design. The three risks that drove the current order are context economy, edit-application reliability, and provider stream behaviour, because all three are resolved by running code rather than by more design.

This roadmap states order and exit criteria only. It states no schedule.

## Dry Structure

```text
turnturn/
  ROADMAP.md
  README.md
  package.json
  pnpm-workspace.yaml
  openspec/
    project.md
    specs/
      agent-harness/
        spec.md
    changes/
      <milestone-change>/
        proposal.md            # why this change exists
        design.md              # decisions. required on every change
        tasks.md               # what to do, with conventions and gotchas inline
        specs/
          <capability>/
            spec.md            # accepted behavior, when the change adds any
        research/
          research.md          # what we borrow and from which reference file
          neutral-challenge.md # contract-altering changes only
          synthesis.md         # contract-altering changes only
  .agents/
    skills/
      turnturn-architecture/
        SKILL.md
```

No separate architecture document set should compete with OpenSpec. Research stays inside the change that produced it. Final decisions for a milestone stay in that change's `design.md`; accepted behavior graduates into `openspec/specs/`.

**Every change has a `design.md`, and it is reviewed before implementation starts.** No exceptions — a change without a validated design does not get built.

What varies is research depth. Contract-altering changes — protocol types, durable record formats, persisted policy semantics, public package APIs — also need a neutral challenge and a synthesis. Every other change needs one `research.md` naming what is borrowed and from where.

Each fact has one home. Scope lives here; decisions live in a change's `design.md`; work lives in its `tasks.md`. Do not restate one in another — link instead.

## V1 Definition of Done

v1 is done when this holds on a repository turnturn has never seen:

> Given a real git repository with a failing test, `turnturn "make the failing test pass"` uses a real model provider, reads the relevant files, proposes an edit the user sees as a diff, asks before running the test command, applies the edit, iterates on failure, and reports the result — without exceeding the model's context window. Interrupting mid-turn and relaunching resumes the session.

### Mechanical gates — v1 blocks on these

Each is fully controlled by the harness, independent of model quality:

- Every turn reaches a terminal state or a structured error. No hangs, no mid-turn exit without a durable record.
- Every proposed edit either applies verifiably on disk or reports a structured failure. No silent partial writes.
- No shell command executes without a policy decision. Denials are recorded and the turn continues.
- The context budget is never exceeded: compaction triggers before the provider rejects a request.
- Killing the process mid-turn and relaunching reconstructs engine state and model-visible history from the durable log.
- Every user-visible action has a correlated durable record traceable in the turn timeline.

### Benchmark — v1 reports, does not gate

Pass rate over a fixed task set of at least 20 tasks on real repositories, recorded per release with turn count and token cost.

## Milestones 0–2: Complete

**M0 — Operating model.** Roadmap, OpenSpec project context, and architecture skill established.

**M1 — Harness boundaries.** Boundary map across engine, renderer, transport, session server, runtime executor, provider, tool/policy, persistence, observability, and memory/subagents. Decided: define a transport-safe protocol, implement in-process first, on condition that every command and event is validated through JSON round-trip.

**M2 — Protocol and event log.** Shipped as `packages/protocol`: provider-neutral types, schema versioning, durable-record vs live-event split, branded IDs, writer-assigned ordering, the tool-use/tool-result state machine, approval and cancellation command semantics, append-only JSONL storage, and separate engine-state and provider-history replay projections. 26 tests pass.

**This contract is frozen.** Later milestones implement against it. Changing it requires its own change with full research.

Command idempotency, lifecycle race behaviour, and provider-specific history validation were deliberately parked for Milestone 3, because they depend on command application semantics that did not exist yet.

The planning changes for these three milestones were deleted on 2026-09-10 once their output was in the code and this roadmap. Reasoning is recoverable from git history.

## Milestone 3: Vertical Slice — First Real Turn

Status: design approved 2026-09-10, implementation starting. Risk retired: does the Milestone 2 contract survive a real provider and real tools?

Goal: one narrow path all the way through — real provider, real tools, real edit on disk — through the Milestone 2 command/event contracts.

OpenSpec change:

- `implement-sequential-agent-loop`
- `implement-web-client-harness` — companion M3 client/transport harness for the minimal renderer exit criterion.

Exit criteria:

- Conversation/session/turn/step lifecycle.
- Engine accepts `CommandEnvelope` input and emits `DurableRecord` plus `LiveEvent` output even for local in-process tests.
- Engine does not rely on renderer callbacks, shared client memory, provider-native durable state, or object references across the boundary.
- Tool use/tool result invariant.
- Policy gate with allow, deny, ask, abort, and modified input.
- Recoverable tool errors remain inside the loop.
- `ProviderPort` designed against both Anthropic and OpenAI stream and tool-call shapes, with neither provider's vocabulary leaking into the port.
- Anthropic adapter wired into the slice: streaming, tool-call assembly from deltas, retry, structured error on mid-stream failure.
- Provider conformance suite derived from the first adapter — the fixture-driven tests every adapter must pass.
- Six tools: `read`, `write`, `edit`, `glob`, `grep`, `shell`.
- Instruction file loading (`AGENTS.md`) and `@file` mention resolution.
- Minimal renderer showing the turn timeline and edit diffs, subscribing through the Milestone 2 in-process transport rather than directly to the engine.
- Scripted provider retained as the default test double; the deterministic suite remains the correctness gate. Adapter tests use recorded stream fixtures; live smoke tests are excluded from the default run.
- Edits land on disk in a real repository.

The OpenAI adapter is v1 scope but not necessarily Milestone 3 scope: it lands against the conformance suite either as Milestone 3 close-out or in Milestone 8 with its auth surface.

## Milestone 3.5: Coding Chat Workspace

Status: design written 2026-09-12, awaiting review. Risk retired: is the engine usable as a product, or only observable?

Inserted rather than appended, on the information-gain rule. Milestone 3 produced an engine and an observability console for it. Milestones 4 through 6 all spend that engine through a human surface — approvals a person has to read, compaction they have to trust, diffs they have to review — and each is easier to design against a real client than to guess at. Building the approval UI in Milestone 4 without a client means building it twice.

Goal: turn the web harness into a coding chat workspace with durable conversations.

OpenSpec change:

- `implement-coding-chat-workspace`
- `implement-model-turn-observability` — companion diagnostic trace and per-turn context inspector; design review is required before implementation.

Exit criteria:

- Durable per-session record logs, one per session, sequences gapless within each. Conversations survive process restart with both `reduceEngineState` and `reduceProviderHistory` reporting no issues.
- The forked provider-history reducer deleted, its trigger condition met.
- Conversation listing, creation, rename, archive, and deletion, listed from an index without reading record bodies.
- Session-scoped record retrieval and conversation-filtered live events. No endpoint and no event stream spans conversations.
- Durable identity assigned by the server. The browser stops minting conversation and session ids.
- Interrupted turns finalized durably on next open, exactly once.
- A conversation projector as a tested component, not a renderer helper: user messages, assistant responses, tool activity grouped per provider step, approvals, recoverable errors, and turn phase.
- Application shell — sidebar, header, transcript, composer — with the selected conversation restored across a reload.
- Markdown, syntax-highlighted code with copy, tables, lists, and clickable workspace file references, with no model-supplied HTML, script, or image reaching the DOM.
- Streaming without duplicated text after live-to-durable reconciliation, proven by a disconnect-and-reconnect comparison against a client that never disconnected.
- Inline approvals, stop, retry, and continue. Scroll position held when the reader scrolls away from a streaming turn.
- Debug surfaces behind an explicit developer mode that can read client state and not write it.
- Per-turn model diagnostics that distinguish semantic context, exact provider request, provider response translation, runtime tool output, and later model-visible consumption.
- Server-owned provider/model discovery for configured Anthropic, LiteLLM, and Ollama connections, with a grouped model picker and no credential or editable endpoint crossing into the browser.
- `Host` and `Origin` validation plus a per-process token on state-changing requests, because `shell` is reachable and unsandboxed until Milestone 4.
- The client reaches the engine only through a transport interface, and imports no `assistant-core` runtime module.
- One real LiteLLM tool-using conversation completed end to end in the product UI, surviving a server restart.

Deferred to v1.x by this milestone, named so they stop competing: queued turns, per-tool cancel, in-app workspace switching, multi-workspace, conversation search, attachments, transcript virtualization, and Electron packaging. Electron is a constraint on this milestone's seams, not a deliverable.

## Milestone 4: Trust Loop

Risk retired: can the user let it run without supervising every call?

Goal: make unattended operation safe enough to be useful.

OpenSpec change:

- TBD

Exit criteria:

- Per-call approval prompts with allow, deny, and always-allow.
- Persisted allow/deny rules surviving restart.
- Workspace path confinement refusing out-of-root targets before execution.
- Shell command parsing sufficient to classify commands for policy, including substitution and chaining.
- macOS Seatbelt sandbox for shell execution, **gated on spike S3**. If `sandbox-exec` cannot be driven without admin rights, v1 ships approvals plus path confinement only and OS sandboxing moves to v1.x. This downgrade is pre-approved.
- No cross-platform sandbox abstraction in v1.

## Milestone 5: Context Economy

Risk retired: does quality survive a long task?

Goal: keep the agent effective past the first few turns.

OpenSpec change:

- TBD

Exit criteria:

- Token budget accounting per turn against the provider window.
- History compaction triggering before the provider rejects a request.
- Compaction recorded durably without mutating raw history.
- Deterministic tool output truncation, visible to the model.
- Threshold set from spike S4 rather than guessed.

## Milestone 6: Edit Reliability

Risk retired: do proposed edits actually land?

Goal: make the edit tool fail rarely and never silently.

OpenSpec change:

- TBD

Exit criteria:

- Failure taxonomy from spike S2 with a test case per class.
- Anchored or fuzzy matching for edits whose target text does not match exactly.
- Structured recoverable failure on mismatch, with no partial write.
- Diff preview before application.
- Retry path when the model's edit omits or elides content.

## Milestone 7: Durability — Hydration, Recall, and Replay

Risk retired: does a session survive a restart with real data?

Goal: make sessions durable across process restarts.

OpenSpec change:

- TBD

Exit criteria:

- Hydration rebuilds engine state.
- Replay reconstructs model-visible history.
- Recall injects summaries/facts without mutating raw history.
- Concurrent writer safety.
- Interrupted turns resume or report as terminated, never silently dropped.

## Milestone 8: Operator Surface

Risk retired: can someone other than us configure and run it?

Goal: make turnturn installable and operable by a new user.

OpenSpec change:

- TBD

Exit criteria:

- Layered config with a schema.
- Credential storage and auth for both v1 providers.
- OpenAI adapter passing the provider conformance suite, if it did not land as Milestone 3 close-out.
- Model selection.
- Token and cost display.
- Non-interactive/headless invocation.
- Minimal structured telemetry.

## Spikes Gating v1 Scope

Each spike is a task in the change for the milestone it feeds.

- **S1 — Provider stream shapes.** Real streams from both Anthropic and OpenAI for interleaved text/tool deltas, partial tool-call JSON, mid-stream refusal, context-limit-hit. Runs before M3; becomes the recorded fixture set and the seed of the conformance suite. Captured for both providers even though only one is wired first — cheapest step to do twice, most expensive to redo.
- **S3 — macOS Seatbelt without admin.** Determines whether the M4 sandbox downgrade fires. Runs before M4.
- **S2 — Edit failure taxonomy.** Naive string-replace failures against real model output. Runs during M3, feeds M6.
- **S4 — Compaction trigger point.** Quality degradation against context fill. Runs during M3, feeds M5.

## Deferred: v1.x

Named, not implicit. Each is independently addable after v1, and none is required for the v1 acceptance scenario. The cut came from inventorying 63 capabilities across codex, gemini-cli, and claude-code: 25 landed in v1, 24 here, 13 below.

- **Parallel tool waves.** Parallel-safe tools overlap; mutating tools serialize by default; results return in original call order; sibling failures do not corrupt successful sibling results. Deferred because the real scheduler requirements are only visible once sequential execution has run against real workloads.
- **Tools.** `ls`, read-many-files, background shell, ask-user, todo/plan tracking, plan mode, web fetch and search, view image.
- **MCP client.**
- **Subagents and skills.**
- **Context.** Processor pipeline, tool output masking, tool result distillation, just-in-time context injection, cross-session memory.
- **Safety.** Network egress policy, sandbox escalation flow, cross-platform sandbox backends.
- **Persistence.** Efficient tail read, log compression and maintenance, session index and search.
- **Surface.** Custom slash commands, provider families beyond Anthropic and OpenAI, model routing and automatic fallback. Two adapters is not the same capability as choosing between them.
- **Operations.** Lifecycle hooks.

## Deferred: Later

Outside the v1 horizon. Recorded so they stop competing for attention.

Deferred tool search, notebook editing, git worktree management, scheduled/cron tasks, language-server integration, pluggable safety checkers, IDE extension, app/session server, web UI, remote and cloud execution, plugin system, realtime and voice transport.
