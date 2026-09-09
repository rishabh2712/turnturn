# Proposal: Implement Sequential Agent Loop

## Summary

Implement turnturn's first executable engine loop through the protocol/event-log contracts.

Milestone 3 proves that a local engine can accept canonical commands, run a scripted provider, execute requested tools sequentially, evaluate policy gates, and emit durable records plus live events without depending on renderer callbacks or provider-native durable state.

## Motivation

Milestone 2 defined the protocol and replay substrate. The next risk is whether real engine code can stay inside that shape once provider steps, tool requests, approvals, cancellation, and recoverable errors enter the loop.

This milestone intentionally starts with a scripted provider so we can test lifecycle correctness before introducing real model-provider adapters.

## Scope

- Scaffold `packages/assistant-core` as the engine package.
- Define provider, tool executor, policy, ID, clock, durable sink, and live sink ports.
- Implement conversation/session creation through command envelopes.
- Implement one sequential turn path with a scripted provider.
- Execute tool calls one at a time in provider order.
- Persist canonical durable records before publishing corresponding live terminal events.
- Preserve recoverable tool failures as terminal tool-result records where safe.
- Implement duplicate command, approval/cancellation race, and same-step sibling behavior now that command application exists.

## Non-Goals

- Real OpenAI/Gemini/provider adapters.
- Remote transport, HTTP, SSE, or WebSocket.
- CLI/debug renderer.
- Parallel tool waves.
- Memory consolidation or subagents.

## Inputs

- `ROADMAP.md`
- `openspec/project.md`
- `openspec/changes/design-harness-boundaries/`
- `openspec/changes/design-protocol-event-log/`
