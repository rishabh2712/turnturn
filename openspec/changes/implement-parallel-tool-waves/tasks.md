# Tasks: Parallel Tool Waves

Status: **design draft; implementation blocked on Rishabh's review of `design.md` D1–D6, the contract challenge/synthesis, and the spec scenarios.** Rishabh agreed to account for admission/barriers, independent failures, bounded read-only deadlines, turn cancellation, and deterministic durable results; that agreement does not close the full design gate. Execute one reviewable slice at a time under `.agents/skills` / the review-before-code convention. Do not commit unless Rishabh asks.

## Working conventions

- Read `openspec/project.md`, this change's `design.md` and `specs/parallel-tool-waves/spec.md`, then `implement-sequential-agent-loop/design.md` B2/B8/B10/B15 and its tool/cancellation tests before coding. D1 explicitly revises only B2's sibling sequencing for admitted reads; it does not relax reducer or approval invariants.
- Do not edit `packages/protocol`, provider adapters, durable record formats, or policy semantics. The only proposed public API addition is the optional read-only deadline configuration on `AssistantServerConfig`; review the contract challenge and synthesis before that edit. Any other public API change requires a renewed contract-altering design gate.
- Emit only `DurableRecordDraft`; the session writer assigns sequence. Every record-producing test asserts `reduceEngineState(records).issues` and `reduceProviderHistory(records).issues` are empty, and every requested tool has one terminal result.
- Write a failing test before each behavioral change. Use deferred promises/barriers to prove overlap and non-overlap; timing-only tests are insufficient. A temporary red demonstration must be made green or removed before a step is declared verified. Preserve existing cancellation metadata for a tool that completes after cancel but before `turn.aborted`. No timeout test may rely on a long wall-clock sleep.
- After each step, run assistant-core lint, build, typecheck, and test. At completion also run assistant-server tests and the repository-wide build/typecheck/tests because session repair and provider history consume the same records.

## Implementer handoff

This section is the handoff; keep implementation guidance here rather than creating a separate document. The full design gate above is still open. Before changing production code, review D1–D6, the spec scenarios, and `research/neutral-challenge.md` / `research/synthesis.md` with Rishabh and obtain approval. Do not interpret approval of the five safety goals as approval of every scheduling and public-API detail.

Start in `packages/assistant-core/src/tool-wave-runner.ts` and its tests; inspect `ports.ts`, `turn-runner.ts`, the record emitter, both reducers, and session repair before touching the scheduler. For deadlines, inspect `packages/assistant-server/src/runtime.ts` and `persistent-runtime.ts`, then the `read`/`glob`/`grep` implementations. Preserve unrelated working-tree changes. Do not commit unless Rishabh asks.

Run `node scripts/check-milestone-gate.mjs implement-parallel-tool-waves` after the design gate is approved. Verify each completed step with `pnpm --filter @turnturn/assistant-core lint`, `build`, `typecheck`, and `test`; at closeout run the assistant-server equivalents and root `pnpm build`, `pnpm typecheck`, and `pnpm test`. Report results per step, tests proving each failure/cancellation/order case, any design deviation, and anything not verified. Never mark a step complete with a failing suite or nonempty reducer issues.

## Design Gate

- [ ] Rishabh reviews and approves D1–D6 and `research/neutral-challenge.md` / `research/synthesis.md`, especially the B2 cancellation revision, built-in allowlist, four-call bound, per-call deadline scope/configuration, sibling-failure isolation, and deterministic terminal ordering.

## Implementation Tasks

### 0. Baseline and planner

- [ ] Record the current test counts. Demonstrate that two independent reads do **not** overlap today with a temporary red barrier test; retain it for Step 2, but do not leave an unexpected failing test in the verified Step 0 suite. Keep the existing provider-order test as the sequential baseline.
- [ ] Add a small internal wave planner/classifier, using `ToolExecutorPort.definitions()` plus the built-in read-only allowlist. Test `[read, grep, edit, glob]`, unknown tools, missing definitions, and the four-call cap. No execution change in this step.

### 1. Bound each admitted read-only call

- [ ] After the contract-altering gate, add an optional `AssistantServerConfig.readOnlyToolTimeouts` policy with a finite positive default, maximum, and optional per-name overrides for `read`, `glob`, and `grep`. Define and validate its numeric bounds at startup; the model does not set these deadlines. Wire the same policy into the memory and persistent server paths without changing `ToolExecutorPort` or protocol shapes.
- [ ] Compose a deadline-enforcing `ToolExecutorPort` around the server's workspace executor. Link each admitted read-only call's controller to the parent turn signal, return one `TOOL_TIMEOUT` failed outcome on deadline, and suppress callbacks and late settlement after the logical outcome. Prove independently timed siblings, an ignored signal, a late resolution/callback, and turn cancellation with deterministic deferred-promise tests.
- [ ] Pass/check the signal through built-in `read`, `glob`, and `grep` operations, including directory traversal and long scans. Verify cancellation stops further traversal where possible; document that the deadline wrapper bounds the logical wait even where a filesystem operation cannot be physically interrupted. Shell retains its existing sequential timeout, and no synthetic timeout is added to `write`/`edit`.

### 2. Execute read-only waves

- [ ] Refactor `ToolWaveRunner` so preparation and execution are separable without duplicating validation/policy. Make the Step 0 overlap test green and prove `[read, read, edit, read]` never lets the final read overtake the edit.
- [ ] Dispatch admitted reads concurrently, collect one logical outcome keyed by `toolCallId` for each, and append terminal results in provider order. Test reversed completion order, mixed success/recoverable failure, timeout, executor throw, `allow-modified` revalidation, denial, policy abort, and an `ask` decision between reads. A tool failure must not cancel a sibling; a policy abort intentionally cancels the turn.
- [ ] Reconcile the stale `ToolExecutorPort.execute` comment with the runner's tested nonfatal executor-throw behavior, without changing the port signature. Test a validation/policy-service exception after earlier siblings were requested: terminate those requests before failing the turn; do not recast the exception as one tool's recoverable failure.

### 3. Cancellation and replay

- [ ] Add a failing mid-wave cancellation test: cancel while two reads are active, settle each requested call within its deadline, append both terminal results before `turn.aborted`, and reject late outcomes/callbacks. Assert no later wave started or acquired a synthetic request/result pair. Reconcile the existing `recordSkippedToolAbort` path with D1, including cancellation during validation/policy preparation.
- [ ] Add a session-log restart test ending mid-wave: repair outstanding requests once, replay cleanly through both reducers, and prove a second open appends nothing.
- [ ] Add a two-step provider-history round trip with at least two parallel read requests/results, then verify the next provider step sees each result paired to its original call id and in provider order.
- [ ] Inject a durable-append failure separately. Do not report an ordinary tool failure or claim a completed/aborted durable turn when the writer cannot persist the required terminal record; record the resulting limitation without altering protocol semantics in this change.

### 4. Close out

- [ ] Run the full verification commands above. Record exact counts and any unverified real-model behavior. Inspect the live activity and durable timeline for one real provider multi-read turn only if an accessible model emits such a turn; do not claim one was observed otherwise.
- [ ] Reconcile every spec scenario against tests, record defects in this task list, and update the roadmap only when the design-approved implementation is actually complete.
