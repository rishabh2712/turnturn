# Synthesis: Protocol and Event Log

## Decision

Turnturn v1 will use a minimal canonical write-ahead event log, not a broad event-sourcing taxonomy.

The durable layer will be called `DurableRecord`. It is the recovery and replay source of truth for model-visible history and core engine state. Live renderer progress will be projected as `LiveEvent` and kept out of the durable cursor. Client intent enters through `CommandEnvelope`.

## How We Got There

- Codex shows the strongest mature pattern: writer-assigned ordering, durable rollout lines, canonical model-visible items, and live UI projections.
- Gemini CLI shows why an event-first protocol is ergonomic, but also why stream-local IDs and multiple truth planes are dangerous.
- agentic-code shows the operational invariant that every tool use must be paired with a tool result, and shows how progress in transcript chains causes replay bugs.
- The neutral challenge argued that full event sourcing is too broad before the sequential loop exists. The stronger v1 path is a minimal write-ahead log that preserves exactly the facts needed for recovery, provider-history projection, and debugging.

## Accepted Architecture

V1 protocol has three semantic planes:

- `CommandEnvelope`: JSON-serializable intent sent into the engine boundary.
- `DurableRecord`: append-only persisted fact with storage-assigned `sequence`.
- `LiveEvent`: ephemeral progress/projection emitted to renderers and subscribers.

`LiveEvent` may reference a durable record or semantic ID, but it does not consume durable sequence numbers and cannot be used as an `afterSequence` resume cursor for durable replay.

## Durable Record Envelope

Every durable record includes:

- `schemaVersion`
- `recordId`
- `sequence`
- `type`
- `createdAt`
- `conversationId`
- `sessionId`
- optional `turnId`
- optional `stepId`
- optional `toolCallId`
- optional `approvalId`
- optional `commandId`
- optional `providerRequestId`
- `payload`

Rules:

- `sequence` is assigned by the session log writer and is the only durable replay ordering authority.
- `recordId` is a prefixed UUIDv7 or equivalent sortable unique ID.
- Semantic IDs use readable prefixes for debugging, such as `conv_`, `sess_`, `turn_`, `step_`, `tool_`, `appr_`, `cmd_`, and `rec_`.
- `createdAt` is metadata only; it is not used for replay ordering.

Rejected:

- Arbitrary `causalEventIds` in v1. Multiple tool calls in one provider step are represented through shared `stepId` and provider order.
- Stream-local event IDs as durable cursors.
- Persisting provider-native objects, callbacks, promises, abort signals, error instances, or file handles.

## Command Envelope

Every command includes:

- `schemaVersion`
- `commandId`
- `type`
- `createdAt`
- optional `conversationId`
- optional `sessionId`
- optional `turnId`
- optional `toolCallId`
- optional `approvalId`
- optional `idempotencyKey`
- `payload`

V1 command types:

- `conversation.create`
- `session.create`
- `turn.submit`
- `approval.resolve`
- `turn.cancel`
- `tool.cancel`

Command handling rules:

- Commands are JSON round-trip safe.
- Commands use `commandId` plus optional `idempotencyKey` for dedupe.
- Duplicate command handling must return or project the already-decided outcome, not rerun side effects.
- Command acknowledgement is not automatically durable; only accepted state changes are durable.

## Live Event Envelope

Every live event includes:

- `schemaVersion`
- `eventId`
- `type`
- `createdAt`
- optional `conversationId`
- optional `sessionId`
- optional `turnId`
- optional `stepId`
- optional `toolCallId`
- optional `approvalId`
- optional `recordId`
- `payload`

Rules:

- Live events are for renderer/subscriber experience.
- Live events do not consume durable `sequence`.
- Live events may be dropped without corrupting replay.
- Progress, deltas, spinners, stdout/stderr deltas, and provider raw chunks are live unless promoted into a terminal durable record.

## Durable Taxonomy

V1 durable records:

- `conversation.created`
- `session.created`
- `turn.started`
- `user.input.accepted`
- `assistant.message.completed`
- `provider.step.started`
- `provider.step.completed`
- `provider.step.failed`
- `tool.requested`
- `approval.requested`
- `approval.resolved`
- `tool.result.completed`
- `tool.result.failed`
- `tool.result.denied`
- `tool.result.aborted`
- `turn.completed`
- `turn.failed`
- `turn.aborted`

Deferred:

- Durable text deltas.
- Durable reasoning deltas.
- Durable usage records.
- Compaction and replay checkpoints.
- Arbitrary causal graph events.
- Remote worker event taxonomies.

## Replay Projections

Replay is not a single concept.

V1 defines two reducers:

- Engine-state reducer: reconstructs current turn/tool/approval state and detects incomplete transitions.
- Provider-history reducer: reconstructs the model-visible conversation to send back to a provider.

Renderer timeline replay is not a v1 durable requirement. Renderers subscribe to `LiveEvent` and can ask for projected current state.

Reducer rules:

- Reducers are versioned alongside schema version.
- Unknown future record types are ignored only if explicitly marked skippable; otherwise replay fails loudly.
- Corrupt trailing JSONL records are reported and skipped only when all prior complete records are valid.
- Missing terminal tool results fail replay validation unless a marked synthetic result can be produced by an explicit repair mode.

## Tool Invariant

Every durable model-requested tool call must produce exactly one terminal model-visible result where the provider protocol requires pairing.

Terminal durable result records:

- `tool.result.completed`
- `tool.result.failed`
- `tool.result.denied`
- `tool.result.aborted`

If no model-visible result can safely be produced, the engine must emit `turn.failed` with a structured protocol error rather than silently continuing.

Synthetic results:

- Must be marked with `synthetic: true`.
- Must include an explicit error code.
- Are allowed only in repair mode or cancellation/denial paths where the model protocol requires a paired result.

Multiple tool calls in one provider step:

- Share `stepId`.
- Carry `providerOrder`.
- Execute sequentially in v1.
- Return provider-history results in provider order unless cancellation/failure rules require terminal synthetic results for skipped siblings.

## Approval And Cancellation Race Rules

Approval lifecycle:

- `approval.requested` is durable in v1 because approval state must survive a restart while a tool is awaiting permission.
- `approval.resolved` is durable when accepted.
- A second resolution for the same `approvalId` is ignored and emitted as live warning only.
- Approval resolution references both `approvalId` and `toolCallId`.

Race precedence:

- If cancellation is accepted before approval resolution, the tool reaches `tool.result.aborted`; later approval resolution is ignored.
- If approval denial is accepted before cancellation, the tool reaches `tool.result.denied`; later cancellation is ignored for that tool.
- If approval allow is accepted and execution has started, cancellation can request abort; final state is `tool.result.aborted` if executor stops, otherwise completed/failed with cancellation metadata.
- Once any terminal tool result is durable, no later command can change that terminal state.

Cancellation accepted means:

- The command was validated against current state.
- The target is not already terminal.
- The engine recorded or will immediately record the resulting terminal state or abort signal.

## Append And Publish Semantics

- Durable records are appended before corresponding live completion events are published.
- One session log has one writer and one monotonic sequence.
- The writer flushes accepted user input before starting provider/tool work.
- On restart, the reader resumes from the last complete valid record.
- Duplicate `recordId` in a log is invalid unless the payload is byte-identical and treated as idempotent recovery.

## Fixture Requirements

Before engine implementation, add fixtures for:

- completed turn with one approved tool
- approval denial
- cancellation while awaiting approval
- cancellation while running
- duplicate approval response
- duplicate command
- corrupt trailing record
- resume after durable sequence
- multiple tool calls emitted in one provider step and executed sequentially

## Consequences

- Milestone 2 remains protocol/storage-focused but avoids designing the full future transport.
- Local in-process transport can be built later over the same JSON-safe envelopes.
- Provider adapters can preserve native IDs as opaque metadata without leaking provider objects into durable records.
- Renderer/UI can be rich without making progress events replay-critical.
- Sequential v1 still avoids a replay trap when providers emit multiple tool calls together.
