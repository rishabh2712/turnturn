# Reference Research Summary

Date: 2026-09-08

## Codex

Relevant lessons:

- Separate session/thread, turn, step, and item.
- Freeze step context for a provider request.
- Persist model-emitted tool calls before execution and append outputs later.
- Centralize policy, approvals, sandboxing, retry, and telemetry outside individual tools.
- Make tool parallelism opt-in and deterministic.
- Treat replay/hydration as a first-class correctness concern.
- Model subagents as real child threads with lineage and scoped runtime state.

Risks to avoid:

- Do not copy production compatibility layers for MCP, plugins, Guardian, realtime, app-server, and rollout migration before turnturn needs them.
- Do not implement full subagent parity before the base harness is stable.

## Gemini CLI

Relevant lessons:

- TypeScript SDK ergonomics matter: `agent`, `session`, `sendStream`, `resumeSession`, `tool`.
- A small `AgentLoopContext` dependency bag is a good implementation boundary.
- Split tool definition, invocation, scheduler, and execution.
- Use a confirmation bus or approval service instead of direct UI ownership.
- Append-friendly session recording supports resume.

Risks to avoid:

- Do not let provider-shaped Gemini types become internal canonical protocol.
- Avoid a giant service-locator config object.
- Avoid multiple event systems before the product needs them.

## agentic-code

Relevant lessons:

- One query/conversation lifecycle owner makes session behavior easier to reason about.
- Preserve the invariant that every `tool_use` receives a `tool_result`.
- Distinguish durable conversation events from ephemeral progress.
- Keep SDK, remote, and UI messages as adapters over internal truth.
- Approval resolution needs a "resolve once" primitive.
- Subagents can start as child query loops with parent summaries.

Risks to avoid:

- Do not let the query loop absorb retries, compaction, memory, hooks, task summaries, and tool execution.
- Avoid broad mutable tool context.
- Avoid remote/local synthetic state becoming executable truth.

