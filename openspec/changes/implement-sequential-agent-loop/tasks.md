# Tasks: Sequential Agent Loop

Decisions are in `design.md` and are not repeated here. Scope is in `ROADMAP.md`. Read both before starting.

## Design Gate

- [x] Complete user interview for intended design, implementation approach, and failure modes.
- [x] Decide provider targets: Anthropic and OpenAI, Anthropic wired first.
- [x] Decide renderer wiring: through the in-process transport.
- [x] Build the S1 capture harness (`scripts/capture-provider-streams.py`).
- [x] Write `design.md` covering ports, policy, ordering, and the frozen-protocol rule.
- [x] **Design review by the user.** Approved 2026-09-10. Implementation may start at T1.

S1 fixture capture is not a gate. The loop is built against the scripted provider; only the real adapter (T4) waits for fixtures.

## Working Conventions

Copied from `packages/protocol`. Match them exactly; they are not obvious and they will bite.

- **ESM only.** `"type": "module"`, `NodeNext` resolution — relative imports need a `.js` extension even in TypeScript source.
- **tsconfig mirrors `packages/protocol/tsconfig.json`**: `ES2022`, `strict`, `declaration`, `outDir: dist`, `rootDir: src`, plus `noUncheckedIndexedAccess` (every index access is `T | undefined`) and `exactOptionalPropertyTypes` (you may not assign `undefined` to an optional property — omit the key).
- **Tests are `node --test` on `.mjs` files against built output.** Not vitest, not jest. Type-level tests go in `test/type-tests.ts` under a separate `--noEmit` config.
- **`serializeJson` is far stricter than `JSON.stringify`.** It rejects `undefined`, `-0`, non-finite numbers, symbols, functions, bigints, sparse arrays, accessor and non-enumerable properties, cycles, and any object whose prototype is not `Object.prototype` or `null`. Class instances, `Date`, `Map`, `Set` all fail. Build payloads as plain object literals.
- **IDs are branded strings** via `formatId(prefix, uuid)`, which validates UUID shape. Generate UUIDs through `EngineIds`, never inline, or tests stop being deterministic.
- **`sequence` is writer-assigned.** Emit `DurableRecordDraft` (typed `sequence?: never`); the sink returns `DurableRecord` with a real sequence. Never invent one.
- **Read `packages/protocol/test/*.test.mjs` first.** It is the closest thing to executable documentation in the repo.

### Definition of done, every task group

`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` pass; new behaviour has a test that fails without it; `reduceEngineState(records).issues` is empty in every test that produces records; no edits to `packages/protocol`; no new dependency without a stated reason.

## T0 — Prerequisites

- [x] Node and pnpm installed. Node v24.21.0 under `~/.local/turnturn-node-v24.21.0`, pnpm 9.12.3 via Corepack in `~/.local/turnturn-bin`. `@turnturn/protocol` builds, typechecks, and its 26 tests pass.
- [x] **Add a formatter config** (Biome is one binary and one file) and wire it into `pnpm lint`. The previous attempt shipped a 1,320-character line because nothing prevented it.
- [x] Toolchain documented in `README.md`. The stale `HANDOFF.md` was deleted rather than refreshed; it duplicated the roadmap and the readme.

## T1 — Package and Ports

- [x] Create `packages/assistant-core`: `@turnturn/assistant-core`, ESM, `workspace:*` dependency on `@turnturn/protocol`, `typescript@5.9.2` and `@types/node@24.9.1` pinned to match the protocol package.
- [x] Define the seven ports from `design.md` Decision 1 in `src/ports.ts`.
- [x] Document on `ToolExecutorPort.execute` that tool-level failure is an outcome and a throw means a broken executor.
- [x] Ship in-memory doubles, exported for reuse: durable sink (calling `serializeJson` on every draft so unpersistable payloads fail in the fastest test), live sink, fixed clock, sequential ids, scripted provider built from `ProviderEvent[]` batches, and allow/deny/ask policies.
- [x] Exhaustiveness type-test on `ProviderEvent`, so adding a variant is a compile error.
- [x] Test: the memory sink rejects a draft carrying a `Date`, a class instance, or an `undefined` property value.
- [x] No loop logic in this task group.

## T2 — The Turn Loop

Entry point: `submit(command: CommandEnvelope): Promise<CommandOutcome>` and `state(): EngineState`, with `CommandOutcome` being `accepted` / `duplicate` / `rejected`. `submit` resolves when the command is applied — for `turn.submit` that means the turn reached a terminal state — so concurrent `submit` calls must be supported. That concurrency is the source of every hard bug below.

### T2R — Refactor Before Race Cases

The first loop slice works, but `engine.ts` became hard to reason about because command routing, provider collection, tool execution, protocol record construction, live publishing, approval waiting, and cancellation state all live in one construct. Split internals before adding the race cases.

- [x] Record the maintainability concern: protocol record construction must not stay mixed with turn control flow.
- [x] Extract an internal `RecordEmitter` that owns durable append, live publish, IDs, clock, append serialization, and live-sink isolation.
- [x] Replace generic `records.append(type, scope, payload)` call sites with intent-named helpers such as `toolDenied`, `turnCompleted`, and `approvalRequested`.
- [x] Extract `ProviderStepRunner`: collect provider events, accumulate text, classify provider failure, and return a step result without executing tools.
- [x] Extract `ToolWaveRunner`: strict provider-order execution, policy decisions, approval waits, tool callbacks, synthetic terminal tool records, and sibling isolation.
- [x] Extract `ApprovalRegistry`: pending approvals, first resolution wins, cancellation clears/rejects pending approvals, no turn resurrection.
- [x] Extract a turn runtime / terminal guard that centralizes cancellation and “once terminal, no later write can overwrite it.”
- [x] Re-run and extend T2 tests after each extraction; refactor commits must not widen the public port surface.

- [x] Conversation, session, turn, and step lifecycle through command envelopes.
- [x] Happy path with the scripted provider, asserted as an exact record-type sequence.
- [x] Multiple same-step tool calls execute strictly in `providerOrder`, proven by an ordering probe rather than timing.
- [x] All five policy outcomes, each asserting its terminal tool status.
- [x] Durable-before-live ordering for terminal facts.
- [x] Tool-use invariant: every `tool.requested` reaches exactly one terminal result — including under cancellation, provider failure, and shutdown. A model that sees a request with no result is looking at a malformed conversation.
- [x] Recoverable tool failures continue the turn to completion.
- [x] Sibling isolation across mixed success and denial; both results reach the next step.
- [x] Command idempotency: same `idempotencyKey` returns `duplicate` with the **original** records, not fresh ones. Commands without a key always apply; never dedupe on payload equality.
- [x] Set `synthetic: true` on result records the engine produced rather than the tool — denial, abort, cancellation backfill. It is how replay tells a real tool error from a policy artifact.
- [x] A throwing `LiveSink` subscriber does not fail the turn.
- [x] `reduceProviderHistory(records)` pairs every request with a result, no issues.

Race cases, each needing a test that a naive implementation fails:

- [x] Cancel during provider streaming — abort the provider, give outstanding requests `aborted` results, then `turn.aborted`. The turn must not later flip to `completed` because an in-flight step resolved after the cancel.
- [x] Cancel during tool execution — the tool's outcome must not overwrite the aborted terminal record. Once a call has a terminal record, further writes are dropped. `CancellationMetadata` exists so a tool that finished during cancellation is recorded truthfully.
- [x] Approval resolved after cancellation — rejected, nothing written, turn not resurrected.
- [x] Duplicate approval resolution — first wins, never two `approval.resolved` records for one approval.
- [x] Cancel before the turn starts, and after it completes — both rejected with a clear code, no second terminal record.

Gotchas:

- Do not let another command interleave between the durable append and the matching publish. Order is observable.
- A single mutable "current turn" object shared across `submit` calls produces exactly the bugs the race tests look for.
- `reduceEngineState` reports `out_of_order` on sequence gaps; if you filter or reorder records anywhere it will tell you.
- Accumulate text deltas and write one `AssistantMessageCompleted`. Never a record per delta.

## T3 — The Six Tools

`read`, `write`, `edit`, `glob`, `grep`, `shell`. Nothing else — `ls`, read-many-files, background shell, ask-user, todos, plan mode, and web access are v1.x.

- [ ] Workspace confinement: every path resolves to an absolute real path inside a configured root. Resolve symlinks **before** checking. Refusal is a `failed` outcome. Test both a `..` escape and a symlink escape.
- [ ] `read` with line-numbered output and offset/limit; binary or non-UTF8 files fail cleanly.
- [ ] `write` full-content, reporting bytes written.
- [ ] `edit` **exact match only**: not-found and multiple-match-without-`replaceAll` each fail with a distinct code and leave the file byte-identical. Assert by comparing bytes before and after. No fuzzy or anchored matching — that is Milestone 6, and these error codes are the data that designs it, so make them specific.
- [ ] `glob` newest-first, capped.
- [ ] `grep` returning structured matches (path, line number, line), not a formatted blob. `ripgrep` is not guaranteed present; prefer a Node implementation.
- [ ] `shell`: stream output through the invocation callbacks, honour `AbortSignal` by killing the **process group**, enforce a timeout distinguishable from a non-zero exit, default to the workspace root.
- [ ] `mutating: true` on `write`, `edit`, `shell` — the v1.x parallel scheduler reads it.
- [ ] Deterministic output truncation, flagged in the result.
- [ ] `AGENTS.md` discovery: walk root-to-file, nearest-last so specific instructions win. Reference: `codex/codex-rs/core/src/agents_md.rs`.
- [ ] `@file` mention resolution; an unresolvable mention stays literal rather than erroring the turn. Reference: `codex/codex-rs/core/src/mention_syntax.rs`.
- [ ] Prove an edit lands verifiably on disk in a real repository.

Gotchas:

- `fs.realpath` throws on a path that does not exist — for `write`, resolve the parent directory instead.
- Killing a process group needs `detached: true` at spawn and `process.kill(-pid)`. Getting it wrong leaves orphans and a mysteriously hanging test suite.
- Collect and stream child output simultaneously. Awaiting completion then emitting everything at once makes live output a lie — the same buffering trap that bit the capture proxy in `research/s1-findings.md`.
- `edit` matches against **file content**, never the line-numbered rendering shown to the model. Test this; it is an easy and confusing bug.
- No sandboxing here. Milestone 4 owns it, which is why the policy gate is in T2 rather than deferred.

## T4 — Anthropic Adapter *(blocked on fixtures)*

Do not start by guessing the wire format from documentation — that is the failure this milestone was reorganised to avoid.

- [ ] Capture Anthropic fixtures: `interleaved`, `truncated-tool-json`, `context-limit`, `refusal`. Recommended path in `research/s1-findings.md` — an API key plus `curl`, which removes the driving agent and gives exact control over `max_tokens`.
- [ ] Capture `interleaved` and `truncated-tool-json` for OpenAI, so the port is validated against two shapes.
- [ ] Implement the adapter with `fetch` and direct SSE parsing. No vendor SDK — it pulls a dependency tree in for a format we must understand at byte level anyway.
- [ ] Tool-call assembly per call id; `tool-call-complete` only on successful parse.
- [ ] Stop-reason mapping to `CompletionReason`, failing loudly on an unrecognised value rather than defaulting silently.
- [ ] Failure classification with `retryable` set deliberately — assert a 429 and a 400.
- [ ] Retry with backoff, jitter, and `retry-after`, without duplicating already-emitted events. State which approach you chose.
- [ ] Emit usage where fixtures contain it.
- [ ] Abort leaves no dangling reader — a test that would otherwise hang.
- [ ] History translation from `ProviderHistory` to provider messages.
- [ ] **Conformance suite** in `test/conformance/`, parameterised over `(adapter, fixtureDirectory)`: feeds fixture bytes through the adapter and asserts the event sequence, under adversarial chunkings — one byte at a time, split mid-SSE-event, **split mid-UTF8-multibyte-character**, and all at once. Asserts no `tool-call-complete` without parseable input, exactly one terminal event, nothing after it.
- [ ] Live smoke test, excluded from the default run.
- [ ] Rewrite `research/s1-findings.md` from observation; reconcile the port against reality and record any change it forced.

Gotchas:

- SSE frames are `\n\n`-delimited but chunk boundaries land anywhere. Buffer across chunks.
- Use a streaming UTF-8 decoder that holds partial sequences; per-chunk `toString("utf8")` corrupts multibyte characters at boundaries.
- Ignore keep-alive pings without treating them as protocol errors.
- An HTTP error may arrive as a JSON body rather than SSE — the pre-stream context-limit rejection is exactly this. Check status and content type first.

## T5 — Transport and Renderer

- [ ] `InProcessTransport` wrapping the engine, round-tripping every command and message through `serializeJson` + `JSON.parse` — an actual round trip, not a type assertion. Test that a `Date`, class instance, or `undefined` fails at the boundary.
- [ ] `subscribe({ afterSequence })` replaying records after that sequence, in order, no duplicates, no gaps.
- [ ] Resume test: consume some records, drop, resume, assert the full set was seen exactly once.
- [ ] A resuming subscriber gets missed **records** but not missed **live events**, asserted explicitly. `LiveEvent.sequence` is typed `never` — leave that trap armed.
- [ ] Bounded buffering for a slow subscriber, dropping live events but never records. State the choice.
- [ ] Minimal line-oriented CLI in `apps/cli` — no TUI framework, no alternate screen. Turn timeline with greppable correlated ids, streaming text, tool output as it arrives.
- [ ] Unified diff rendered before an edit applies. This is an exit criterion, not a nicety.
- [ ] Approval prompt reading stdin and sending `approval.resolve` back through the transport.
- [ ] Ctrl-C sends `turn.cancel` and waits for a terminal record. Do not `process.exit()` — that skips the durable terminal record and leaves a session looking live forever.
- [ ] End-to-end run against a real temp git repository using the scripted provider.

Gotchas:

- `JSON.parse` returns `any`. Re-validate on the way in with `validateDurableRecord`; casting blindly means the round trip proves nothing.
- Branded IDs come back as plain strings — re-brand via `parseId`, do not cast.
- The renderer must not read files itself to build a diff. It renders what crosses the transport.

## Spikes During This Milestone

- [ ] S2 — classify `edit` exact-match failures against real model output. T3's error codes are the raw data. Feeds Milestone 6.
- [ ] S4 — measure quality degradation against context fill on a multi-file task. Feeds Milestone 5.

## Close-out

- [ ] Validate OpenSpec change.
- [ ] Update `ROADMAP.md` Milestone 3 status.
- [ ] Carry the token-usage protocol gap (`design.md`, Known Gap) into the Milestone 5 change.
