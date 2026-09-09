# Design: Protocol and Event Log

Status: challenged and synthesized; ready for protocol/storage implementation

## Design Goal

Define the canonical protocol substrate that later engine work must use.

Turnturn v1 will use a minimal canonical write-ahead event log, not a broad event-sourcing taxonomy. The durable layer is the recovery and replay source of truth for model-visible history and core engine state. Live renderer progress is projected separately and kept out of the durable cursor. Client intent enters through explicit command envelopes.

This milestone is the contract gate for engine implementation. Remote transport and parallel execution can wait, but their enabling contracts cannot be retrofitted after the engine grows callback-shaped assumptions.

## How We Got Here

Research inputs:

- `research/codex.md`
- `research/gemini-cli.md`
- `research/agentic-code.md`
- `research/neutral-challenge.md`
- `research/synthesis.md`

Reference conclusions:

- Codex shows the strongest mature pattern: writer-assigned ordering, durable rollout lines, canonical model-visible items, and live UI projections.
- Gemini CLI shows why an event-first protocol is ergonomic, but also why stream-local IDs and multiple truth planes are dangerous.
- agentic-code shows the operational invariant that every tool use must be paired with a tool result, and shows how progress in transcript chains causes replay bugs.
- The neutral challenge argued that full event sourcing is too broad before the sequential loop exists. The stronger v1 path is a minimal write-ahead log that preserves exactly the facts needed for recovery, provider-history projection, and debugging.

## Core Concepts

```text
CommandEnvelope
  JSON-serializable intent sent into the engine boundary

DurableRecord
  append-only persisted fact with storage-assigned sequence

LiveEvent
  ephemeral renderer/subscriber projection

Engine-State Reducer
  durable-record projection that rebuilds current engine state

Provider-History Reducer
  durable-record projection that rebuilds model-visible provider history
```

## Architecture Decision

V1 has three semantic planes:

- `CommandEnvelope` for control intent.
- `DurableRecord` for recovery and replay.
- `LiveEvent` for renderer progress.

`LiveEvent` may reference a durable record or semantic ID, but it does not consume durable sequence numbers and cannot be used as a durable replay cursor.

Tradeoff:

- This is more structure than a single callback-driven in-process API, but it prevents renderer progress, provider-native objects, and approval callbacks from becoming hidden engine dependencies.
- It is less structure than full event sourcing because v1 excludes causal graphs, durable deltas, compaction, remote fanout, and transport backpressure.

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
- The durable envelope must never contain provider SDK objects, callbacks, promises, abort signals, error instances, or file handles.

Rejected:

- Arbitrary `causalEventIds` in v1. Multiple tool calls in one provider step are represented through shared `stepId` and provider order.
- Stream-local event IDs as durable cursors.

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

Rules:

- Commands must be JSON round-trip safe.
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

## Replay

Replay is not one concept.

V1 defines two reducers:

- Engine-state reducer: reconstructs current turn/tool/approval state and detects incomplete transitions.
- Provider-history reducer: reconstructs the model-visible conversation to send back to a provider.

Renderer timeline replay is not a v1 durable requirement. Renderers subscribe to `LiveEvent` and can ask for projected current state.

Reducer rules:

- Reducers are versioned alongside schema version.
- Unknown future record types are ignored only if explicitly marked skippable; otherwise replay fails loudly.
- Corrupt trailing JSONL records are reported and skipped only when all prior complete records are valid.
- Missing terminal tool results fail replay validation unless a marked synthetic result can be produced by an explicit repair mode.

## Tool-Use/Tool-Result Invariant

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

## Approval Semantics

Approvals are commands and durable state changes, not callbacks.

Rules:

- `approval.requested` is durable in v1 because approval state must survive restart while a tool is awaiting permission.
- `approval.resolved` is durable when accepted.
- A second resolution for the same `approvalId` is ignored and emitted as a live warning only.
- Approval resolution references both `approvalId` and `toolCallId`.
- Denial produces `tool.result.denied` when a model-visible tool result can be safely produced.

## Cancellation Semantics

V1 cancellation scopes:

- turn
- tool call

Deferred:

- session cancellation
- provider-request cancellation
- arbitrary step cancellation
- approval-request cancellation independent of tool cancellation

Cancellation accepted means:

- The command was validated against current state.
- The target is not already terminal.
- The engine recorded or will immediately record the resulting terminal state or abort signal.

Race precedence:

- If cancellation is accepted before approval resolution, the tool reaches `tool.result.aborted`; later approval resolution is ignored.
- If approval denial is accepted before cancellation, the tool reaches `tool.result.denied`; later cancellation is ignored for that tool.
- If approval allow is accepted and execution has started, cancellation can request abort; final state is `tool.result.aborted` if executor stops, otherwise completed/failed with cancellation metadata.
- Once any terminal tool result is durable, no later command can change that terminal state.

## Append And Publish Semantics

- Durable records are appended before corresponding live completion events are published.
- One session log has one writer and one monotonic sequence.
- The writer flushes accepted user input before starting provider/tool work.
- On restart, the reader resumes from the last complete valid record.
- Duplicate `recordId` in a log is invalid unless the payload is byte-identical and treated as idempotent recovery.

## Provider Neutrality

Provider adapters may know native stream details. Core durable records must not expose native provider objects.

Provider adapters map native stream events into:

- live content/reasoning deltas
- live raw/provider diagnostic chunks when enabled
- durable assistant message completion
- durable tool request
- durable provider step terminal state
- structured provider errors

Opaque provider request/response IDs may be stored as string metadata.

## First Implementation Slice

`packages/protocol` defines the three envelope families and their JSON serialization fixtures. Storage, command handling, and replay remain separate implementation tasks; serialization examples do not demonstrate valid lifecycle transitions.

Implementation choices and tradeoffs:

- The initial wire schema uses numeric `schemaVersion: 1`. Runtime version checks and future-version rejection must be implemented with the reader/transport decoders; the current serializer validates JSON representation only.
- Use explicit TypeScript string enums for protocol discriminators, with enum values equal to the stable persisted JSON wire strings. This keeps implementation code centralized around symbols such as `CommandTypes.TurnSubmit` while preserving readable logs such as `"turn.submit"`. Numeric or implicit enum values are forbidden.
- Use discriminated TypeScript unions with payloads and required scope IDs per message type. This follows the tagged messages observed in the reference implementations and catches mismatched payloads during development. Type checking does not replace runtime validation of untrusted transport input or persisted records.
- Keep writer-assigned `sequence` out of durable drafts and live events. This makes the ordering ownership explicit before the log writer is implemented.
- Keep ID formatting/parsing separate from ID generation. Codex's `protocol/src/response_item_id.rs` makes this distinction; the runtime must supply UUIDv7 IDs when creating new records. A formatter alone does not guarantee uniqueness or time ordering.
- Reject JSON values that would be silently dropped or changed, including runtime objects and non-finite numbers. This costs a validation traversal but exposes serialization mistakes before they become persistence or reconnect defects.
- Preserve a provider's tool-call ID only as opaque string metadata alongside the canonical tool ID. This supports later adapter pairing without importing SDK objects into the protocol.

The engine implementation gate remains closed until the remaining storage, replay, idempotency, and race fixtures pass.

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

Each fixture must prove:

- JSON round-trip preserves required fields.
- Replay reconstructs model-visible messages and tool results in deterministic order.
- Ephemeral events are not required.
- Invalid or incomplete transitions are detected.
