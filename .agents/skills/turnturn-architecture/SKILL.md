---
name: turnturn-architecture
description: Use when planning, designing, or implementing turnturn's coding-assistant harness so decisions follow the v1 roadmap, OpenSpec artifacts, and architecture decision discipline.
---

# turnturn Architecture

Use this skill for turnturn roadmap, architecture, and harness implementation work.

## Required Context

Before making architectural or implementation decisions, read:

- `docs/roadmap-v1.md`
- `docs/architecture-decisions.md`
- Relevant OpenSpec artifacts under `openspec/specs/` and `openspec/changes/`

When a task concerns the coding harness, inspect the relevant reference implementation locally before deciding:

- `/Users/zoomroom_bangalore/Desktop/source/codex`
- `/Users/zoomroom_bangalore/Desktop/source/gemini-cli`
- `/Users/zoomroom_bangalore/Desktop/source/agentic-code`

## Reference Exploration Workflow

When the user asks to validate, choose, freeze, or recommend a harness architecture, spawn three parallel explorer subagents before finalizing the recommendation:

- Codex explorer: inspect `/Users/zoomroom_bangalore/Desktop/source/codex` for session/turn/step orchestration, provider boundary, tool runtime, policy/approval handling, persistence, tracing, parallelism, memory/compaction, and subagents.
- Gemini CLI explorer: inspect `/Users/zoomroom_bangalore/Desktop/source/gemini-cli` for TypeScript SDK shape, `AgentLoopContext`, provider/model abstractions, tool registry, confirmation bus, session/resume, and missing extension points.
- agentic-code explorer: inspect `/Users/zoomroom_bangalore/Desktop/source/agentic-code` for `QueryEngine`, message adapters, permission handling, session history, remote/local rendering, memory mechanics, and task/subagent patterns.

Integrate the reports into `docs/recommended-design-v1.md` before treating the roadmap as implementation-ready.

## Decision Discipline

Every major design choice must record:

- Decision made.
- How we got there.
- Reference inspiration or observed code path.
- Engineering tradeoffs considered.
- Consequences for engine, renderer, persistence, provider adapters, tools, approvals, tracing, memory, or subagents.

Update `docs/architecture-decisions.md` when a new decision is made or an existing one changes.

## v1 Boundaries

- Keep the engine separate from CLI, web, desktop, and SDK renderers.
- Keep provider-specific formats behind adapters.
- Persist canonical events, not provider-native messages.
- Model conversation, session, turn, step, tool call, and approval as separate concepts.
- Start sequential tool execution first; add parallel waves only after lifecycle and error semantics are tested.
- Treat recoverable tool failures as structured tool results where safe.
- Keep memory consolidation and subagents separate from raw renderer state.

## OpenSpec Workflow

Use OpenSpec for task management:

- New architectural or feature work starts as an OpenSpec change.
- Specs define required behavior.
- Design records approach and tradeoffs.
- Tasks stay implementation-oriented and verifiable.
- Do not implement from chat-only requirements when an OpenSpec change is expected.
