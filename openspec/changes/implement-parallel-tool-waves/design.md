# Design: Parallel Tool Waves

Status: **design approved by Rishabh on 2026-09-23; ready for implementation.** `ROADMAP.md` owns priority; this document owns the scheduling decisions. The user interview, reference research, neutral challenge, and synthesis are in `research/` because the optional server timeout configuration changes a public package API.

## Problem and current flow

One provider step can return several tool calls. `ToolWaveRunner.run()` currently loops through them in provider order, validates and decides policy for one, records its request, waits for any approval, executes it, records a terminal result, and only then considers the next. Two independent reads therefore wait on each other. This ordering also hides the fact that `ToolDefinition.mutating` has already been defined but has no scheduling use.

The durable session log is the source of truth. `reduceEngineState` requires a request before its approval/result and exactly legal state transitions; `reduceProviderHistory` uses the durable order to construct the next provider request. Live output and observations are provisional, not substitutes for terminal records.

## Target flow

The runner partitions one provider step into contiguous waves in provider order. A wave may contain at most four calls, and only the built-in `read`, `glob`, and `grep` tools whose definitions say `mutating: false`. `write`, `edit`, `shell`, unknown/custom tools, and any call requiring human approval are singleton barriers. A later read cannot jump ahead of an earlier barrier. There is no parallelism across provider steps, turns, or conversations beyond what the engine already supports.

For a read-only wave, prepare each call in provider order: validate input, decide policy, apply and revalidate modifications, and append `tool.requested` before dispatch. Only calls with a final `allow` or `allow-modified` decision join the wave. A `deny`, `abort`, `ask`, invalid input, or changed mutability classification flushes the current wave and is handled by the existing sequential path. Then dispatch admitted calls concurrently. Each receives its own bounded deadline and abort signal linked to the turn signal. Collect one logical outcome per call, including executor throws and timeouts, before appending terminal records in provider order. Each call keeps its own id, observation scope, and result. Live progress may arrive in completion order and must retain those ids.

Pseudo-flow:

```text
for call in provider order:
  if not known read-only: flush wave; run existing sequential call
  else prepare call under current validation/policy rules
       if it needs approval or cannot join: flush wave; resolve it sequentially
       else append request; add to wave
  if wave has four calls: flush wave
flush final wave

flush wave:
  start all admitted calls with distinct deadlines and linked cancellation
  collect one settled outcome per call, keyed by toolCallId
  append each terminal result in provider order; ignore late settlements
```

## D1 — Deliberate revision of sequential B2

`implement-sequential-agent-loop/design.md` B2 required `policy → tool.requested → ... → terminal result, then the next` to simplify cancellation. Parallelism necessarily revises only the *then the next* part for admitted read-only siblings. The retained constraints are: policy and final validated input precede each request; each approval/result follows its own request; no unrequested action executes; and all requested calls have exactly one terminal record before `turn.completed` or `turn.aborted`. The protocol shape and writer-assigned sequence remain unchanged. Mutating and approval calls keep B2's original sequence. Once cancellation stops admission, calls beyond the active wave are not requested merely to write synthetic aborted pairs. This intentionally differs from the current `recordSkippedToolAbort` path and needs a reducer/replay test before removal.

## D2 — Safety boundary and policy

Admission uses the tool definition and an explicit built-in allowlist, not a name string alone and not model-supplied metadata. Unknown custom tools are barriers even if a future definition says `mutating: false`, until their concurrency contract is reviewed. Policy still runs for each call. `allow-modified` is revalidated, and no changed input bypasses policy. An `ask` pauses the wave boundary and uses the existing approval registry; it never executes concurrently with another call. A denied call returns a tool result and the turn may continue. An `abort` cancels the turn and prevents later calls from starting.

## D3 — Deterministic durable outcomes, truthful live activity

Requests and terminal results are appended in provider order, with a bounded maximum of four in flight. The next provider step starts only after every admitted call has a logical outcome and all requested calls have terminal results. Results are associated by tool-call id, not completion order or array position. The serialized record writer assigns sequence; completion order never does. Live progress and observations may interleave, but each carries its own scope; the UI must not infer durable completion from a live delta. A recoverable failure, timeout, or executor throw in one read becomes only that call's failed result and does not cancel siblings. Policy `abort` and user `turn.cancel` are turn-wide by design. A validation/policy-service exception is an infrastructure failure: drain or abort any earlier calls already requested for the pending wave before recording a terminal turn failure. A durable-append failure is not a recoverable tool result; do not claim a completed or aborted durable turn when the required append cannot succeed. The current `ToolExecutorPort` comment says a throw fails the turn while `ToolWaveRunner` catches it as a failed call; reconcile that comment with the tested behavior without changing the port signature.

## D4 — Cancellation and restart

`turn.cancel` aborts the turn signal, which aborts every active call's linked signal. Already-started calls are allowed to settle or report abort according to their executor outcome, preserving the current cancellation metadata rule. A call that ignores its signal still reaches a bounded logical outcome through its deadline; a late physical settlement cannot append a second result, emit further model-visible output, or complete the turn. The runner drains the wave, writes one terminal result per requested call, and only then writes `turn.aborted`. Calls beyond the active wave neither start nor acquire a new `tool.requested` record. There is no user-facing per-tool cancel in this change: `tool.cancel` remains unsupported. On process restart, the existing session-sink repair remains responsible for requested-but-unterminated calls; tests must include a log ending mid-wave and verify a second open adds nothing.

## D5 — Boundaries and deferred work

The scheduler belongs in `assistant-core` behind `ToolExecutorPort`; tool implementations and provider adapters do not learn wave mechanics. The server composes a deadline-enforcing `ToolExecutorPort` around its workspace executor, while built-in read/search tools cooperate with the supplied signal. No protocol or durable-record change is planned. The proposed optional server timeout configuration is a public package API change, so the contract-altering research challenge and synthesis must be reviewed before implementing it. Do not add user-supplied `wait_for_previous`, per-tool cancellation, speculative dispatch while provider output is streaming, parallel writes, shell overlap, cross-turn queues, or memory/context work here. Managed shell sessions, OS sandboxing/approval escalation, structured patch editing, dynamic custom-tool parallelism, and general model-visible output budgeting remain separate work. If a test shows the current protocol cannot represent the wave faithfully, stop and reopen the contract-altering design gate rather than patching around it.

## D6 — Bounded per-call deadlines for admitted reads

Each admitted `read`, `glob`, or `grep` gets an independent, host-owned deadline. The server configuration supplies a finite positive default, a finite maximum, and optional per-tool-name overrides; an override cannot exceed the maximum. No read/search timeout parameter is exposed to the model. The deadline wrapper links a per-call controller to `turn.cancel`, distinguishes `TOOL_TIMEOUT` from a turn cancellation, suppresses callbacks after logical settlement, and accepts only the first outcome. The built-in file/search implementations must check cancellation during traversal and pass abort signals into cancellable filesystem operations where supported. A misbehaving executor may physically continue after the wrapper has returned; because only read-only built-ins are admitted, a late outcome is discarded, but tests must prove no late record or output escapes. This is a bounded logical wait, not a promise of physical termination for arbitrary custom executors.

The existing shell timeout remains in force for sequential shell calls; the new wrapper does not grant shell overlap. Do not put a synthetic logical timeout around `write` or `edit`: they could modify a file after the model was told they failed. A later all-tool timeout design must specify physical interruption and side-effect certainty before claiming that guarantee. The configurable server API and its alternatives are challenged in `research/neutral-challenge.md` and reconciled in `research/synthesis.md`.

## Rejected options

- `Promise.all` over every provider call: crosses write/approval barriers and obscures cancellation.
- Parallelizing every `mutating: false` definition immediately: custom tools may hide state or external side effects.
- Append results whenever calls finish: makes model-visible order scheduling-dependent and complicates replay.
- Rewrite the protocol to include a wave id: existing `stepId`, `toolCallId`, `providerOrder`, and writer sequence suffice for this bounded scope.
- One shared wave timer: a slow sibling should not change another call's deadline or outcome.
- A `Promise.race` that merely stops waiting on a mutating operation: it can report failure while a write later succeeds.
