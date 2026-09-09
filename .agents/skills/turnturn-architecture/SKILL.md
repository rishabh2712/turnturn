---
name: turnturn-architecture
description: Use when planning, designing, or implementing turnturn's coding-assistant harness so decisions follow the v1 roadmap, OpenSpec artifacts, and architecture decision discipline.
---

# turnturn Architecture

Use this skill for turnturn roadmap, architecture, and harness implementation work.

## Required Context

Before making architectural or implementation decisions, read:

- `ROADMAP.md`
- `openspec/project.md`
- Relevant OpenSpec artifacts under `openspec/specs/` and `openspec/changes/`

Treat `ROADMAP.md` as the root milestone source of truth. OpenSpec changes define milestone implementation details. When a milestone is completed, update `ROADMAP.md` in the same work.

Milestone sequencing is dependency-driven. Do not treat a boundary hypothesis as implementation approval when a later contract milestone still defines its viability.

Do not create or extend parallel long-form architecture docs under `docs/` unless the user explicitly asks. Put durable architecture context in `openspec/project.md`, milestone conclusions in `openspec/changes/<change>/design.md`, accepted behavior in `openspec/specs/`, and raw research in `openspec/changes/<change>/research/`.

When a task concerns the coding harness, resolve the turnturn repo root and inspect the relevant reference implementations from sibling paths before deciding:

- `../codex`
- `../gemini-cli`
- `../agentic-code`

If a reference repo is missing, record the missing path in the current OpenSpec research artifact and continue with the available evidence. Do not write machine-specific absolute paths into durable docs.

## Reference Exploration Workflow

Before starting implementation for any new milestone, the current OpenSpec change MUST pass a design gate. Do not write implementation code until the change contains:

- User interview notes covering what design the user expects, how implementation should proceed, and which failure modes must be addressed.
- `research/codex.md`
- `research/gemini-cli.md`
- `research/agentic-code.md`
- `research/neutral-challenge.md`
- `research/synthesis.md`
- A completed `## Design Gate` checklist in `tasks.md`
- A `design.md` updated from the user interview, reference research, neutral challenge, and synthesis

Run `pnpm check:milestone <change-id>` before implementation. If it fails, stop implementation and complete the missing design-gate work first.

When interviewing the user for a milestone, capture answers to:

- What are we designing in this milestone?
- How should the implementation be approached?
- Which failure modes must this milestone address?
- Which failure modes are explicitly parked for a later milestone?
- What would make this design unacceptable even if the code works?

When the user asks to validate, choose, freeze, recommend, or implement a harness architecture milestone, spawn three parallel explorer subagents before finalizing the recommendation:

- Codex explorer: inspect `../codex` for session/turn/step orchestration, provider boundary, tool runtime, policy/approval handling, persistence, tracing, parallelism, memory/compaction, and subagents.
- Gemini CLI explorer: inspect `../gemini-cli` for TypeScript SDK shape, `AgentLoopContext`, provider/model abstractions, tool registry, confirmation bus, session/resume, and missing extension points.
- agentic-code explorer: inspect `../agentic-code` for `QueryEngine`, message adapters, permission handling, session history, remote/local rendering, memory mechanics, and task/subagent patterns.

Preserve the raw reports in `openspec/changes/<change>/research/`, then integrate them into `research/synthesis.md` and the change's `design.md` before treating the roadmap as implementation-ready.

## Model Routing

Use explicit model routing for delegated work when the tool supports model selection:

- Research/explorer subagents: use `gpt-5.5`.
- Synthesis/reconciliation subagents: use `gpt-5.6-sol`.
- Code-writing subagents: use `gpt-5.6-luna`.

Keep the main agent responsible for integrating results, checking tradeoffs, and preserving raw research in OpenSpec.

## Decision Discipline

Every major design choice must record:

- Decision made.
- How we got there.
- Reference inspiration or observed code path.
- Engineering tradeoffs considered.
- Consequences for engine, renderer, persistence, provider adapters, tools, approvals, tracing, memory, or subagents.

Record major decisions in the relevant OpenSpec `design.md` or `research/synthesis.md`. Use a separate ADR file only if the user explicitly asks for formal ADRs.

## v1 Boundaries

- Keep the engine separate from CLI, web, desktop, and SDK renderers.
- Keep provider-specific formats behind adapters.
- Persist canonical events, not provider-native messages.
- Model conversation, session, turn, step, tool call, and approval as separate concepts.
- Define protocol/event-log contracts before engine scaffolding depends on them.
- Build even local v1 through the serialized boundary: `CommandEnvelope -> Engine -> DurableRecord + LiveEvent`.
- Do not implement the first engine around renderer callbacks, approval callbacks, shared client memory, or object references crossing the engine boundary.
- Approval is represented as serializable messages, not callback ownership.
- Subscription/replay cursors are based on durable record ordering, not ephemeral live-event IDs.
- Start sequential tool execution first; add parallel waves only after lifecycle and error semantics are tested.
- Sequential v1 must still represent multiple tool calls emitted by one provider step, with stable provider order.
- Treat recoverable tool failures as structured tool results where safe.
- Keep memory consolidation and subagents separate from raw renderer state.

## OpenSpec Workflow

Use OpenSpec for task management:

- New architectural or feature work starts as an OpenSpec change.
- Every implementation milestone includes a `## Design Gate` in `tasks.md` before implementation tasks.
- Specs define required behavior.
- Design records approach and tradeoffs.
- Tasks stay implementation-oriented and verifiable.
- Do not implement from chat-only requirements when an OpenSpec change is expected.
