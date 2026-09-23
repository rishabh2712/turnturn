# Tasks: Parallel Tool Waves

Status: **design approved by Rishabh on 2026-09-23; ready for implementation.** Execute one reviewable slice at a time under `.agents/skills` / the review-before-code convention. Do not commit unless Rishabh asks.

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

- [ ] Record the current test counts. Demonstrate that two independent reads do **not** overlap today with a temporary red barrier test; retain it for Step 2, but do not leave an unexpected failing test in the verified Step 0 suite. Keep the existing provider-order test as the sequential baseline.
- [x] Add a small internal wave planner/classifier, using `ToolExecutorPort.definitions()` plus the built-in read-only allowlist. Tests cover built-in read/search, mutating and unknown tools, missing definitions, and the four-call cap.

The first Step 0 checkbox is historical and remains open: no pre-implementation red run was preserved. The retained no-definition sequential fixture and the new deterministic overlap/barrier tests prove current behavior, but they do not recreate that earlier evidence.

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

- [ ] Add a failing mid-wave cancellation test: cancel while two reads are active, settle each requested call within its deadline, append both terminal results before `turn.aborted`, and reject late outcomes/callbacks. Assert no later wave started or acquired a synthetic request/result pair. Reconcile the existing `recordSkippedToolAbort` path with D1, including cancellation during validation/policy preparation.
- [ ] Add a session-log restart test ending mid-wave: repair outstanding requests once, replay cleanly through both reducers, and prove a second open appends nothing.
- [x] Add a two-step provider-history round trip with parallel reads; the next provider step sees both results paired by original call id and in provider order, with both reducers clean.
- [ ] Inject a durable-append failure separately. Do not report an ordinary tool failure or claim a completed/aborted durable turn when the writer cannot persist the required terminal record; record the resulting limitation without altering protocol semantics in this change.

### 4. Close out

- [ ] Run the full verification commands above. Record exact counts and any unverified real-model behavior. Inspect the live activity and durable timeline for one real provider multi-read turn only if an accessible model emits such a turn; do not claim one was observed otherwise.
- [ ] Reconcile every spec scenario against tests, record defects in this task list, and update the roadmap only when the design-approved implementation is actually complete.
