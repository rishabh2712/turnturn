# Design: turnturn v1 Harness Roadmap

## Architecture Shape

turnturn v1 is engine-first. The engine owns sessions, turns, provider steps, tool scheduling, policy checks, persistence, and trace events. Renderers consume event streams and send user actions back through public commands.

The core boundary is:

- `Conversation`: user-visible continuity and durable history.
- `Session`: runtime environment, provider configuration, tool registry, and cancellation scope.
- `Turn`: one user submission and all model/tool work needed to answer it.
- `Step`: one provider request/response cycle inside a turn.
- `ToolCall`: one model-requested action, governed by policy and execution metadata.

## Component Plan

- `engine`: agent loop, turn state machine, step runner.
- `protocol`: canonical message/event schema.
- `providers`: provider adapters from canonical request to provider-specific API and back.
- `tools`: registry, declaration schema, execution contracts, policies, and scheduler.
- `persistence`: append-only event store, hydration, recall, replay, snapshots.
- `observability`: trace IDs, timelines, metrics, redaction.
- `memory`: summaries/facts/consolidation interfaces.
- `subagents`: child-session model and parent-child event linking.

## Tool Execution Model

Phase 1 starts sequential:

1. Provider emits one or more tool calls.
2. Engine records requested events.
3. Policy gate evaluates each call.
4. Allowed calls execute.
5. Denied/aborted/failed calls produce structured tool results where safe.
6. Tool results are fed into the next provider step.

Parallelism arrives as waves:

- A wave is a set of tool calls from the same provider response that may execute concurrently.
- Tools must declare parallel-safety.
- Mutating tools are serialized by default.
- Results are grouped in original call order before returning to the provider.

## Persistence Model

The first storage layer should be append-only and provider-neutral:

- conversation created
- session created
- turn started
- provider request started/completed/failed
- tool requested/approved/running/completed/failed/aborted
- approval requested/answered
- assistant content emitted
- turn completed/failed/aborted
- summary/fact produced

Hydration rebuilds runtime state from the event log. Recall selects relevant prior material for a new turn. Replay rebuilds model-visible history from canonical stored events.

## Error Model

Errors are classified by blast radius:

- Tool-local recoverable error.
- Approval denial or abort.
- Tool timeout or cancellation.
- Provider stream error.
- Persistence error.
- Fatal engine invariant violation.

Recoverable tool errors remain in the loop. Fatal engine errors stop the turn but preserve persisted context for resume.

## Observability

Every event includes:

- `conversationId`
- `sessionId`
- `turnId`
- optional `stepId`
- optional `toolCallId`
- `traceId`
- timestamp
- status
- parent ID
- redaction classification

The timeline renderer is a debugging tool, not the engine.

## Decision Discipline

Each implementation change must update `docs/architecture-decisions.md` or link to an existing ADR when it makes or depends on a major architectural choice.

