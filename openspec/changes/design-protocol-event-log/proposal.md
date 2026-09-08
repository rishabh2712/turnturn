# Proposal: Design Protocol and Event Log

## Summary

Define turnturn's canonical protocol and event-log contract before engine implementation begins.

This milestone turns the boundary-design conclusion into enforceable protocol decisions: event identity, ordering, schema versioning, durable versus ephemeral events, command/event serialization, replay fixtures, tool-use/tool-result state machine, approval resolution, and cancellation semantics.

## Motivation

The harness boundary design produced a conditional go: the architecture direction is sound, but implementation must not start until protocol/event-log contracts are explicit. Otherwise the in-process engine may accidentally depend on callbacks, provider-native objects, unordered events, or non-replayable state.

## Scope

- Define canonical command and event envelopes.
- Define event IDs, ordering, parent/causal IDs, and schema versioning.
- Define durable versus ephemeral event rules.
- Define tool-use/tool-result state transitions.
- Define approval and cancellation command semantics.
- Define provider-neutral stream event mapping constraints.
- Define JSON serialization round-trip fixture requirements.
- Define replay fixture requirements for one completed turn.

## Non-Goals

- Implement the engine loop.
- Implement provider adapters.
- Implement a local HTTP/SSE/WebSocket transport.
- Implement full hydration, memory, subagents, or parallel tool waves.

## Inputs

- `ROADMAP.md`
- `openspec/project.md`
- `openspec/changes/design-harness-boundaries/`
- `openspec/changes/design-protocol-event-log/research/`

