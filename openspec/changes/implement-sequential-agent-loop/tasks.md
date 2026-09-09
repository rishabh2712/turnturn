# Tasks: Implement Sequential Agent Loop

- [x] Create OpenSpec change `implement-sequential-agent-loop`.
- [x] Draft proposal and initial design for Milestone 3.

## Design Gate

Do not start implementation tasks until every item in this gate is complete and `pnpm check:milestone implement-sequential-agent-loop` passes.

- [ ] Complete user interview for intended design, implementation approach, and failure modes.
- [ ] Preserve Codex reference research in `research/codex.md`.
- [ ] Preserve Gemini CLI reference research in `research/gemini-cli.md`.
- [ ] Preserve agentic-code reference research in `research/agentic-code.md`.
- [ ] Run neutral challenge in `research/neutral-challenge.md`.
- [ ] Write synthesis in `research/synthesis.md`.
- [ ] Update `design.md` from synthesis and user interview.
- [ ] Validate OpenSpec change.

## Implementation Tasks

- [ ] Scaffold `packages/assistant-core` as a TypeScript package.
- [ ] Define engine ports for provider, tool executor, policy, durable sink, live sink, IDs, and clock.
- [ ] Implement conversation/session command handling.
- [ ] Implement one sequential turn happy path with a scripted provider.
- [ ] Execute multiple same-step tool calls sequentially in provider order.
- [ ] Implement policy allow, deny, ask, abort, and modified-input outcomes.
- [ ] Implement command idempotency outcomes for duplicate submit, approval, and cancellation commands.
- [ ] Implement approval/cancellation race behavior.
- [ ] Preserve recoverable tool errors as terminal tool-result records where safe.
- [ ] Verify engine-state and provider-history reducers can replay engine output.
- [ ] Validate OpenSpec change.
