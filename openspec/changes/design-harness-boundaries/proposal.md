# Proposal: Design Harness Boundaries

## Summary

Define the first implementation-ready design for turnturn's coding harness boundaries, including engine, client/renderer, transport, app/session server, executor, provider, tool/policy, persistence, observability, memory, and subagent boundaries.

## Motivation

The current v1 roadmap identifies the right harness themes, but implementation should not begin until the system boundaries are explicit. In particular, turnturn needs to decide what transport exists in v1, what app-server-like concepts are only designed, and what remains out of scope.

## Scope

- Define the v1 boundary map.
- Preserve reference research and neutral challenge under this change.
- Decide whether v1 implements in-process transport only, local server transport, or an abstraction with one concrete implementation.
- Decide where app/session server responsibilities live.
- Identify missing areas from the baseline roadmap.

## Non-Goals

- Implement the engine.
- Build a UI.
- Implement remote app server, cloud execution, or full MCP runtime.
- Rework repository docs outside the consolidation plan.

