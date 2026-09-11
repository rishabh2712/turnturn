# Proposal: Web Client Harness

## Why this change exists

Milestone 3 has proved most of the engine as a library: provider adapters, workspace tools, policy, durable records, and a one-shot e2e runner. What is still missing is a real client surface that drives the engine through a serialized transport boundary.

The next useful proof is not a CLI. A CLI would exercise the loop, but it would be a throwaway client. A React web client is the reusable shape for the later Electron renderer, local developer UI, hosted dev UI, and embedded panels.

This change builds a thin local web server plus React client that talks to the engine only through HTTP/SSE transport. It is a harness, not the final app.

## What this retires

- Whether the command/event protocol is usable from a browser client.
- Whether resume-by-durable-sequence works through an actual network boundary.
- Whether approvals, cancellation, tool calls, durable records, and live deltas are understandable in one operator surface.
- Whether local Ollama can be tested interactively without adding a dead-end CLI.

## Scope boundary

This change does not change `packages/protocol`. It uses the existing `CommandEnvelope`, `DurableRecord`, and `LiveEvent` shapes.

It does not introduce durable disk persistence. In-memory engine state is enough for the harness; process restart durability remains Milestone 7.

