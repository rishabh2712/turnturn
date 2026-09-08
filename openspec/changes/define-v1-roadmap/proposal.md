# Proposal: Define turnturn v1 Roadmap

## Summary

Freeze the first-phase roadmap for turnturn's coding assistant harness. The v1 scope is an engine-first architecture for agent turns, provider adapters, tool invocation policies, persistence, hydration, replay, resilient error handling, tracing, and future-ready memory/subagent boundaries.

## Motivation

turnturn needs a durable design before implementation starts. The harness must be inspired by Codex's loose coupling and observability while remaining TypeScript-friendly enough to build quickly. Decisions must record how they were reached and what tradeoffs were considered.

## Scope

- Define the v1 roadmap and implementation phases.
- Establish OpenSpec as task-management source of truth.
- Capture architecture decisions and tradeoffs.
- Define current requirements for the agent loop, provider layer, tools, sessions, persistence, errors, tracing, memory, and subagents.
- Add a project skill so future work follows the roadmap and decision-log discipline.

## Non-Goals

- Implement the engine.
- Build the UI.
- Select every production storage/backend detail.
- Create full memory or subagent systems in v1.

## References

- `../codex`
- `../gemini-cli`
- `../agentic-code`
- `ROADMAP.md`
- `openspec/project.md`
- `openspec/changes/design-harness-boundaries/`
