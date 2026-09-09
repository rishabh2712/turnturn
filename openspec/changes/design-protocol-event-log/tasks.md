# Tasks: Design Protocol and Event Log

- [x] Create OpenSpec change `design-protocol-event-log`.
- [x] Draft proposal for protocol/event-log milestone.
- [x] Draft initial protocol/event-log design.
- [x] Preserve raw Codex protocol/event-log research in `research/codex.md`.
- [x] Preserve raw Gemini CLI protocol/event-log research in `research/gemini-cli.md`.
- [x] Preserve raw agentic-code protocol/event-log research in `research/agentic-code.md`.
- [x] Run neutral challenge using `gpt-5.6-sol`.
- [x] Write final synthesis using `gpt-5.6-sol`.
- [x] Update design from synthesis.
- [x] Update root `ROADMAP.md` with the selected OpenSpec change name for Milestone 2.
- [x] Validate OpenSpec change.

## Implementation Tasks For Milestone 2

- [x] Define protocol types for `CommandEnvelope`, `DurableRecord`, `LiveEvent`, typed IDs, structured errors, and supported v1 record/command types.
- [x] Add JSON round-trip fixtures for command envelopes, durable records, live events, and structured errors.
- [x] Implement append-only JSONL session log writer with writer-assigned sequence and duplicate `recordId` handling.
- [x] Implement JSONL reader with corrupt trailing-record recovery and strict required-metadata validation.
- [x] Implement engine-state reducer for turn/tool/approval state.
- [x] Implement provider-history reducer for model-visible history.

## Parked Until Engine Or Provider Adapters Exist

These are intentionally not Milestone 2 implementation tasks. Milestone 2 keeps the protocol fields and durable record types that make them possible; the actual behavior should be implemented when there is an engine command application path or provider adapter to validate against.

- [ ] Implement command idempotency semantics for duplicate submit, approval, and cancellation commands in the sequential engine milestone.
- [ ] Implement approval/cancellation race behavior in the sequential engine milestone.
- [ ] Implement multi-tool same-step sequential-order behavior in the sequential engine milestone.
- [ ] Add provider-specific tool-use/tool-result validation and explicit synthetic-result gates in the provider adapter milestone.

## Implementation Gate

Do not start engine implementation until this change answers:

- event ID and sequence strategy
- schema versioning strategy
- durable versus ephemeral rules
- command envelope
- event envelope
- tool-use/tool-result state machine
- approval resolution semantics
- cancellation race semantics
- provider stream mapping constraints
- JSON round-trip fixture expectations
- replay fixture expectations

Implementation of command idempotency, approval/cancellation races, and provider-specific history validation is not part of this gate; only the protocol hooks and durable taxonomy are required here.
