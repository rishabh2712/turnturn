# Tasks: Parallel Tool Waves

Status: **design approved by Rishabh on 2026-09-23; implementation verified and archived on 2026-09-26.** The earlier one-slice review convention applied during implementation; Rishabh later requested completion and merge.

## Working conventions

- Read `openspec/project.md`, this change's `design.md` and `specs/parallel-tool-waves/spec.md`, then `implement-sequential-agent-loop/design.md` B2/B8/B10/B15 and its tool/cancellation tests before coding. D1 explicitly revises only B2's sibling sequencing for admitted reads; it does not relax reducer or approval invariants.
- Do not edit `packages/protocol`, provider adapters, durable record formats, or policy semantics. The only proposed public API addition is the optional read-only deadline configuration on `AssistantServerConfig`; review the contract challenge and synthesis before that edit. Any other public API change requires a renewed contract-altering design gate.
- Emit only `DurableRecordDraft`; the session writer assigns sequence. Every record-producing test asserts `reduceEngineState(records).issues` and `reduceProviderHistory(records).issues` are empty, and every requested tool has one terminal result.
- Write a failing test before each behavioral change. Use deferred promises/barriers to prove overlap and non-overlap; timing-only tests are insufficient. A temporary red demonstration must be made green or removed before a step is declared verified. Preserve existing cancellation metadata for a tool that completes after cancel but before `turn.aborted`. No timeout test may rely on a long wall-clock sleep.
- After each step, run assistant-core lint, build, typecheck, and test. At completion also run assistant-server tests and the repository-wide build/typecheck/tests because session repair and provider history consume the same records.

## Implementer handoff

This section is the handoff; keep implementation guidance here rather than creating a separate document. The full design gate below is approved. Before changing production code, read D1–D6, the spec scenarios, and `research/neutral-challenge.md` / `research/synthesis.md`. If implementation reveals a need to change the approved contract, stop and bring that change back for review.

Start in `packages/assistant-core/src/tool-wave-runner.ts` and its tests; inspect `ports.ts`, `turn-runner.ts`, the record emitter, both reducers, and session repair before touching the scheduler. For deadlines, inspect `packages/assistant-server/src/runtime.ts` and `persistent-runtime.ts`, then the `read`/`glob`/`grep` implementations. Preserve unrelated working-tree changes. Do not commit unless Rishabh asks.

Run `node scripts/check-milestone-gate.mjs implement-parallel-tool-waves` before implementation. Verify each completed step with `pnpm --filter @turnturn/assistant-core lint`, `build`, `typecheck`, and `test`; at closeout run the assistant-server equivalents and root `pnpm build`, `pnpm typecheck`, and `pnpm test`. Report results per step, tests proving each failure/cancellation/order case, any design deviation, and anything not verified. Never mark a step complete with a failing suite or nonempty reducer issues.

## Design Gate

- [x] Rishabh reviewed and approved D1–D6 and `research/neutral-challenge.md` / `research/synthesis.md` on 2026-09-23, including the B2 cancellation revision, built-in allowlist, four-call bound, per-call deadline scope/configuration, sibling-failure isolation, and deterministic terminal ordering.

## Implementation Tasks

### 0. Baseline and planner

- [x] Record the baseline and the historical evidence limit. The pre-implementation red overlap run was not preserved and cannot be recreated after the scheduler changed; the retained sequential fixture and deterministic overlap/barrier tests now prove the intended before/after behavior without claiming that missing red run occurred.
- [x] Add a small internal wave planner/classifier, using `ToolExecutorPort.definitions()` plus the built-in read-only allowlist. Tests cover built-in read/search, mutating and unknown tools, missing definitions, and the four-call cap.

The missing pre-implementation red run remains an explicit historical evidence gap, not an unimplemented runtime behavior.

### 1. Bound each admitted read-only call

- [x] After the contract-altering gate, add optional `AssistantServerConfig.readOnlyToolTimeouts` with bounded default, maximum, and per-name overrides. Startup validation occurs when the runtime constructs the wrapper; the persistent session registry reuses `runtime.tools`. No protocol or `ToolExecutorPort` shape changed.
- [x] Wrap the workspace executor with independent read/search deadlines and linked turn cancellation. Tests cover a timed-out sibling alongside success, ignored abort, immediate turn cancellation, suppression of output and settlement after a logical terminal outcome, and first-outcome precedence when timeout-triggered abort reentrantly cancels the turn.
- [x] Pass/check the signal through built-in `read`, `glob`, and `grep`, including per-entry and per-line checks during traversal/scanning and `fs.readFile` abort where supported. Pre-cancelled and mid-traversal cases are tested. Directory calls without native cancellation can finish one in-flight filesystem operation before the next check; the wrapper still bounds the logical wait. Shell keeps its own timeout; no synthetic timeout was added to `write`/`edit`.

### 2. Execute read-only waves

- [x] Coordinator slice: separate inspection from durable effects; drain earlier requested reads before approval, denial, abort, invalid input, or mutating barriers. Abort queued requests on policy/validation exception before `turn.failed`; do not admit later calls after cancellation. Four deterministic tests cover these boundaries. Inspection and wave execution now have separate internal modules; the core suite passes 111/111. This does not close the broader Step 2 or Step 3 scenarios below.
- [x] Refactor `ToolWaveRunner` so preparation and execution are separate. Deterministic barriers prove two reads overlap while `[read, read, edit, read]` cannot cross the edit.
- [x] Dispatch admitted reads concurrently, retain each outcome with its call id, and append terminal results in provider order. Tests cover reversed completion, recoverable failure, timeout, executor throw, `allow-modified` revalidation, denial, policy abort, and approval between reads; a failed sibling does not cancel its peer.
- [x] Reconcile the `ToolExecutorPort.execute` comment with tested nonfatal executor-throw behavior. Policy-service and validation exceptions after an earlier request abort that request before `turn.failed`; neither is recast as a recoverable tool result.
- [x] Fix the approval visibility race found during coordinator testing: `approval.requested` is durable, the waiter registers, then the live event publishes. A live sink that resolves immediately now succeeds on its first attempt; both reducers report no issues.

Pre-Step-3 verification on 2026-09-23: design gate passed; assistant-core lint/build/typecheck and **128/128** tests passed; assistant-server lint/build/typecheck and **74/74** tests passed; root lint/build/typecheck/test passed. No live-model multi-read turn was run or claimed.

### 3. Cancellation and replay

Each row is one Work Order section. Task checkboxes/evidence track Turnturn implementation; Codex review is a separate state owned by Codex. Turnturn stops after one section and returns a DELIVERY. Codex updates review state only after the worker turn stops, then either requests changes to that same section or assigns the next one.

| Section | Scope | Implementation | Codex review |
| --- | --- | --- | --- |
| 3.A | Mid-wave cancellation (first task below) | Complete | Accepted 2026-09-25 |
| 3.B | Session-log restart repair (second task below) | Complete | Accepted 2026-09-25 |
| 3.C | Two-step provider-history replay (third task below) | Complete | Accepted 2026-09-25 |
| 3.D | Durable-append failure (fourth task below) | Complete | Accepted 2026-09-26 |

Codex verification 2026-09-25: reviewed the cancellation ordering/callback test, mid-wave restart repair/idempotence test, and provider-history replay pairing against D1–D4 and the checked-in design. Focused assistant-core suite passed 33/33; assistant-server storage-sink suite passed 5/5. Both reducers have no issues in the added test cases.

- [x] Add a mid-wave cancellation test: cancel while two reads are active, settle each requested call within its deadline, append both terminal results before `turn.aborted`, and reject late outcomes/callbacks. Assert no later wave started or acquired a synthetic request/result pair. Reconcile the existing `recordSkippedToolAbort` path with D1, including cancellation during validation/policy preparation.

  Completed 2026-09-23 with zero production changes: the coordinator refactor (commit `3b03a3d`) had already removed `recordSkippedToolAbort`, so that reference was stale and no synthetic request/result pairs were restored for calls never requested. The deterministic test "cancel while two reads are active drains them before turn.aborted and rejects late activity" (core suite) composes the engine with the production deadline wrapper, proves both reads in flight before `turn.cancel`, asserts one terminal result per requested call in provider order before `turn.aborted` with cancellation metadata, no request or execution for the later `edit`/`read` calls, no late records or live output after abort, and both reducers clean. Temporary mutations (removing the admission breaks; dropping cancellation metadata) were each caught by the test before being reverted. The existing "cancellation during policy preparation does not admit a later read" test covers preparation-phase cancellation. Verified: assistant-core lint/build/typecheck and 129/129 tests; reviewed and approved by Rishabh on 2026-09-23.
- [x] Add a session-log restart test ending mid-wave: repair outstanding requests once, replay cleanly through both reducers, and prove a second open appends nothing.

  Completed 2026-09-23 with zero production changes. The test "opening a session log interrupted mid-wave repairs both requested reads once and pairs them in provider order" (assistant-server sink suite) builds a fixture whose durable log ends with two requested-but-unterminated `read` calls in one provider step — proving two requests were durable at interruption, not that the executors had started (`tool.started` is live-only). One open appends exactly two synthetic `SERVER_RESTARTED` tool aborts in request order, one `provider.step.failed`, and one `turn.aborted`; both reducers replay clean; the projected provider history pairs each request with its aborted result by call id in provider order without claiming a next provider step ran; a second open appends nothing (byte-for-byte). Mutation checks: skipping the second tool's repair and reordering turn abort before tool repairs were each caught; treating `Aborted` as non-terminal in `terminalTool` was behaviorally inert because second-open idempotence rests on the turn's terminal status. Verified: assistant-server lint/build/typecheck and 75/75 tests; reviewed and approved by Rishabh on 2026-09-23.
- [x] Add a two-step provider-history round trip with parallel reads; the next provider step sees both results paired by original call id and in provider order, with both reducers clean.
- [x] Inject a durable-append failure separately. Do not report an ordinary tool failure or claim a completed/aborted durable turn when the writer cannot persist the required terminal record; record the resulting limitation without altering protocol semantics in this change.

  Completed 2026-09-26 with zero production changes. A deterministic sink rejects the first `ToolResultCompleted` append after two reads execute. Submission rejects with the writer error; neither tool gets a terminal record, no turn terminal or next provider step is claimed, no live terminal event appears, and both reducers report no issues for the still-running log. The `RecordEmitter` append chain remains rejected in that process, so recovery requires a process restart; existing session-log repair then handles outstanding requests. This test does not claim a live writer failure was exercised.

### 4. Close out

- [x] Run the full verification commands above. Record exact counts and any unverified real-model behavior. Inspect the live activity and durable timeline for one real provider multi-read turn only if an accessible model emits such a turn; do not claim one was observed otherwise.
- [x] Reconcile every spec scenario against tests, record defects in this task list, and update the roadmap only when the design-approved implementation is actually complete.

Closeout on 2026-09-26: the design gate passes. Assistant-core passes 130/130 tests and assistant-server passes 75/75; root build, typecheck, and test pass. Both package lint checks pass. Root lint in the parallel worktree was blocked only by whitespace in the unrelated, unmerged `apps/web/src/styles.css` edit. After the parallel-only commit was fast-forwarded into clean main, root lint, build, typecheck, and test all passed. The spec scenarios for overlap/barriers, provider-order replay, sibling failures and deadlines, cancellation, and restart repair have deterministic tests; durable append failure is separately injected as required by D3. No real-model multi-read turn was observed or claimed.
