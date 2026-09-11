# Tasks: Sequential Agent Loop

Decisions are in `design.md` and are not repeated here. Scope is in `ROADMAP.md`. Read both before starting.

## Design Gate

- [x] Complete user interview for intended design, implementation approach, and failure modes.
- [x] Decide provider targets: Anthropic and OpenAI, Anthropic wired first.
- [x] Decide renderer wiring: through the in-process transport.
- [x] Build the S1 capture harness (`scripts/capture-provider-streams.py`).
- [x] Write `design.md` covering ports, policy, ordering, and the frozen-protocol rule.
- [x] **Design review by the user.** Approved 2026-09-10. Implementation may start at T1.

S1 fixture capture is not a gate. The loop is built against the scripted provider. Real adapters may be built live-first against configured provider endpoints; fixtures are kept as regression/conformance evidence once useful streams have been observed.

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
- [x] Replace the temporary provider-history filter/renumber path with a real per-session record list. B11 says provider history comes from the current session log, not the global sink; never fabricate `sequence` to placate `reduceProviderHistory`.
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

### T3R — Tool Executor Refactor

The first implementation put registry, path confinement, input parsing, six tool handlers, shell process management, AGENTS.md discovery, mention resolution, and result shaping into one module. That is the same maintainability smell T2 had: correct ingredients, wrong ownership. Gemini keeps one file/class per tool with shared path utilities; Codex separates router, registry, handlers, runtimes, sandboxing, and lifecycle. Match that shape before extending tools.

Architectural lesson from Gemini and Codex: tool execution wants layers, not a bag of functions. Keep these responsibilities distinct:

```text
tool registry / router
  decides which tool exists and how it is exposed

tool invocation object / handler
  validates args, describes the action, gathers policy metadata

guardrail layer
  path access, sandboxing, approval, workspace confinement

runtime / executor
  actually performs filesystem/process/network work

result shaping
  turns runtime outcome into model-visible output, UI display, errors, telemetry
```

For this milestone, `ToolExecutorPort` remains the engine-facing seam, but the implementation behind it must be composed:

- Registry is not execution. `workspace-tools.ts` should answer only “which tool name was called?” and “which handler receives it?”
- Guardrails should be shared and boring. File-ish tools must all go through realpath confinement before side effects.
- Shell execution is a runtime, not a helper. It owns process-group cleanup, timeout, abort, streaming, and truncation semantics.
- Tool result error codes are product contract, not incidental strings. Preserve specific codes such as `EDIT_NOT_FOUND`, `EDIT_MULTIPLE_MATCHES`, `PATH_OUTSIDE_WORKSPACE`, `SHELL_TIMEOUT`, `SHELL_NON_ZERO_EXIT`, and `SHELL_ABORTED`.
- Invocation metadata will likely grow beyond `execute(input)`. Future tool objects may need `definition`, `mutating`, `validate`, `describe`, `locations`, and `execute`; v1 keeps only `workspaceToolDefinitions`.
- Cancellation is runtime-owned. A runtime that starts work must define how `AbortSignal` stops that work and how the outcome is reported.
- Context helpers are not tools. AGENTS.md discovery and `@file` mention resolution are tool-adjacent context helpers, not `read`/`edit` handlers.

The intended boundary is: engine does not know tools; the tool executor does not know every implementation detail; each tool family owns its runtime behavior; shared guardrails run before any side effect.

- [x] Record the maintainability concern: the tool executor facade must not own every tool implementation detail.
- [x] Keep `workspace-tools.ts` as a small public facade: tool metadata, factory, and name-to-handler dispatch only.
- [x] Extract `WorkspacePathGuard` for realpath confinement, default-root resolution, `..` escapes, symlink escapes, and write-to-new-path ancestor handling.
- [x] Extract input/result helpers so individual tools return stable failed outcomes instead of throwing for model-caused errors.
- [x] Extract file tools (`read`, `write`, `edit`) from search and shell concerns.
- [x] Extract search tools (`glob`, `grep`) and keep the Node implementation independent of `ripgrep`.
- [x] Extract shell runtime behavior: process-group kill, timeout/abort classification, streaming callbacks, and truncation.
- [x] Extract AGENTS.md discovery and `@file` mention resolution as context helpers, not tool handlers.
- [x] Re-run T3 tests after the split; the refactor must not change public exports or task behavior.

- [x] Workspace confinement: every path resolves to an absolute real path inside a configured root. Resolve symlinks **before** checking. Refusal is a `failed` outcome. Test both a `..` escape and a symlink escape.
- [x] `read` with line-numbered output and offset/limit; binary or non-UTF8 files fail cleanly.
- [x] `write` full-content, reporting bytes written.
- [x] `edit` **exact match only**: not-found and multiple-match-without-`replaceAll` each fail with a distinct code and leave the file byte-identical. Assert by comparing bytes before and after. No fuzzy or anchored matching — that is Milestone 6, and these error codes are the data that designs it, so make them specific.
- [x] `glob` newest-first, capped.
- [x] `grep` returning structured matches (path, line number, line), not a formatted blob. `ripgrep` is not guaranteed present; prefer a Node implementation.
- [x] `shell`: stream output through the invocation callbacks, honour `AbortSignal` by killing the **process group**, enforce a timeout distinguishable from a non-zero exit, default to the workspace root.
- [x] `mutating: true` on `write`, `edit`, `shell` — the v1.x parallel scheduler reads it.
- [x] Deterministic output truncation, flagged in the result.
- [x] `AGENTS.md` discovery: walk root-to-file, nearest-last so specific instructions win. Reference: `codex/codex-rs/core/src/agents_md.rs`.
- [x] `@file` mention resolution; an unresolvable mention stays literal rather than erroring the turn. Reference: `codex/codex-rs/core/src/mention_syntax.rs`.
- [x] Prove an edit lands verifiably on disk in a real repository.

Gotchas:

- `fs.realpath` throws on a path that does not exist — for `write`, resolve the parent directory instead.
- Killing a process group needs `detached: true` at spawn and `process.kill(-pid)`. Getting it wrong leaves orphans and a mysteriously hanging test suite.
- Collect and stream child output simultaneously. Awaiting completion then emitting everything at once makes live output a lie — the same buffering trap that bit the capture proxy in `research/s1-findings.md`.
- `edit` matches against **file content**, never the line-numbered rendering shown to the model. Test this; it is an easy and confusing bug.
- No sandboxing here. Milestone 4 owns it, which is why the policy gate is in T2 rather than deferred.

## T4 — Provider Adapters

Build adapters live-first through the shared `ProviderPort`, then preserve observed streams as fixtures for regression. Do not let fixture capture block adapter implementation, but do keep the parser testable without network by separating stream parsing from HTTP transport.

LiteLLM is not one adapter and not one proof source. It is one gateway exposing multiple routes, and each route defines the wire contract the engine sees. The same backend family can sit behind several routes: a Bedrock Claude model can stream as OpenAI-compatible `/v1/chat/completions` or as Anthropic-shaped `/v1/messages`; an OpenAI model can stream through the same chat-completions route; a Mistral Bedrock model can also stream through chat completions. Therefore:

- Adapter selection is by **route/wire format**, not model family or model brand.
- Backend family is recorded as evidence metadata: `bedrock`, `vertex`, `anthropic`, `openai`, `mistral`, etc.
- Fixtures from the company LiteLLM + Bedrock route are `deployed-environment` / `compatibility` evidence, not native Anthropic public API truth.
- A fixture proves native Anthropic truth only when the request reaches `api.anthropic.com` without translation. The current Bedrock path does not.
- For v1, prefer route-named adapters: `OpenAIChatCompletionsAdapter` and `AnthropicMessagesAdapter`. Avoid names such as “Claude adapter”; Claude is a model family, not a wire format.

Observed LiteLLM probes with the temporary test key:

| Route | Backend/model family | Observed stream | Adapter |
| --- | --- | --- | --- |
| `/v1/chat/completions` | Bedrock Claude, OpenAI GPT, Bedrock Mistral | OpenAI-compatible SSE `chat.completion.chunk` frames plus `[DONE]` | `OpenAIChatCompletionsAdapter` |
| `/v1/messages` | Bedrock Claude | Anthropic Messages-shaped SSE events: `message_start`, `content_block_delta`, `message_delta`, `message_stop` | `AnthropicMessagesAdapter` |

That makes `/v1/chat/completions` the first implementation target: it covers different model families behind LiteLLM with one wire adapter. `/v1/messages` follows as a second wire adapter, but the Bedrock-backed captures remain compatibility/deployed-environment evidence unless direct Anthropic public API is later added.

The live lanes are:

```text
Anthropic native
  source: direct Anthropic API, or LiteLLM /anthropic/* pass-through after verifying upstream api.anthropic.com
  wire: /v1/messages SSE
  purpose: native Anthropic adapter

OpenAI-compatible chat
  source: OpenAI-compatible endpoint, LiteLLM /v1/chat/completions, or Ollama /v1/chat/completions
  wire: /v1/chat/completions SSE
  purpose: v1 second adapter

LiteLLM gateway
  source: company LiteLLM /v1/messages
  wire: Anthropic-format translated stream
  purpose: compatibility evidence only, not provider truth

Ollama local
  source: local Ollama
  wire: /v1/chat/completions SSE
  purpose: offline smoke for the OpenAI-compatible chat adapter
```

Model brand does not choose the adapter. Wire format chooses the adapter.

### T4R — Adapter Layering Refactor *(do before T4A)*

Design: `design.md` Decision 12. The justification is **not** file length — codex's `client.rs` is 2,744 lines and gemini's `geminiChat.ts` is 1,881, so neither reference supports that rule. The justification is that the stream state machine must be separately constructible, the way gemini's `agent/event-translator.ts` is, so stream edge cases become unit tests instead of async-iterator archaeology.

Target layout in `design.md` Decision 12. Do this before T4A: history translation has to change anyway to group tool calls, and that is the same file the tool work touches.

Seven known defects, each mapping to exactly one file in the split. That correspondence is the test of whether the decomposition is real.

**Step 0 — folder structure**

Do the moves first, with no behaviour change, so every later step is a small diff in one file.

- [x] Create `src/providers/openai-chat-completions/` and move the current adapter in as `adapter.ts`.
- [x] Add `index.ts` as a **narrow facade** — adapter class, options type, ollama preset. Never `export *`. See Decision 12; `session-provider-history.ts` already leaked through a barrel once.
- [x] **No temporary re-export shim.** Only three code sites import the flat path — `src/index.ts`, `providers/ollama-chat-completions.ts`, and the conformance test — so update them in the same commit. "Remove the old flat file later" is how two import paths become permanent. A shim would be right at thirty call sites, not three.
- [x] **Collapse the Ollama adapter into a preset.** Delete `OllamaChatCompletionsAdapter` and its options type; export an `ollamaChatCompletions(...)` factory from the facade. It is 33 lines of delegation expressing two default values, and Decision 8 says deployment does not get its own adapter.
- [x] Fix the untruthful record: `ProviderPort.name` feeds `session.created.provider`, which currently claims the wire is `ollama-chat-completions`. It is `openai-chat-completions`. Deployment identity belongs in fixture `source`/`backend` metadata, not the adapter name.
- [x] Move tests to `test/providers/openai-chat-completions/` and `test/providers/sse.test.mjs`.
- [x] Leave `test/conformance/` holding **only** the parameterised `(adapter, fixtures)` suite from T4C. It currently holds three unit-test files, so the folder name already misdescribes it. That distinction is what makes "conformance" a gate the Anthropic adapter must pass rather than a directory name.
- [x] Tests stay green across the move with no assertion changes. If an assertion has to change, the move stopped being a move.

**Step 1 — `history.ts`**

- [x] Extract `providerHistoryToChatMessages`.
- [x] **Bug (a): multi-tool steps produce an invalid conversation.** Today each `ToolRequest` item becomes its own `{ role: "assistant", tool_calls: [one] }`. OpenAI-compatible APIs require a **single** assistant message carrying every `tool_call` from that step, followed by the `tool` messages. Group by `stepId`.
- [x] Assistant messages carrying `tool_calls` need `content: null`.
- [x] Assistant text and tool calls from the same step belong in **one** message, not two.
- [x] Test a multi-tool round-trip: two calls in one step, both results, replayed into a second step.
- [x] **Bug (g): a legitimately `null` tool output reports the error instead.** The `output ?? error ?? {status}` chain treats `null` — a valid `JsonValue` — as absent and falls through.

**Step 2 — `frames.ts` + `translate.ts`**

- [x] `frames.ts`: parse one SSE `data:` payload into a typed `ChatFrame | Done`. Safe reads over untrusted JSON live here, not in a generic `json.ts`.
- [x] `translate.ts`: explicit `TranslationState` plus `translateFrame(frame, state): ProviderEvent[]`, mirroring gemini's translator. Keep `mapFinishReason` here as a pure function.
- [x] Port the five edge cases as unit tests against `translateFrame`, no async iterator: usage after finish, `tool_calls` with no calls, `stop` with pending calls, `[DONE]` after finish, stream ends without `[DONE]`.
- [x] **Bug (d): `[DONE]` with no prior finish reason yields `completed: "complete"`.** That is a guess. B4 says absence of a finish reason means `interrupted`.
- [x] **Bug (e): empty usage events.** `extractUsage` returns an object whenever a `usage` key exists, even with no recognised field, so `{ type: "usage", usage: {} }` can be emitted. Emit nothing when no field is recognised.
- [x] **Bug (f): no guard after `finish_reason`.** The loop keeps processing chunks, so post-finish content still emits `text-delta`.

**Step 3 — `tool-calls.ts`**

- [x] `ChatToolCallAssembler` owning delta merging, start detection, and completeness. All four rules in one place: how deltas merge, when a call starts, when arguments are parseable, what a contradictory finish reason means.
- [x] **Bug (b): `tool-call-start` can fire repeatedly.** `started` is derived from "this delta carried an `id`", so a gateway repeating the id on every delta emits multiple starts for one call. Start must fire exactly once per call id.
- [x] **Bug (c): `callId` is frozen at creation with a synthetic fallback.** `mergeToolCall` sets `callId` only when the entry is created, defaulting to `tool-${index}`. A real id arriving in a later delta is discarded — and that wrong id then goes back to the provider as `tool_call_id` in history, producing a conversation the provider rejects.
- [x] Keep the B3 agreement rules here rather than inline in the finish-reason branch.

**Step 4 — `request.ts`**

- [x] Extract body and header construction as `buildChatCompletionsRequest({ model, history, tools, settings })`.
- [x] Test the body independently: history maps correctly, auth header present for LiteLLM and absent for keyless Ollama.
- [x] Adding `tools` becomes a two-line change here, which is the point of doing T4R first. T4R intentionally did not add `ProviderRequest.tools`; that belongs to T4A.

**Step 5 — `http.ts` and `adapter.ts`**

- [x] `http.ts`: fetch wrapper plus HTTP failure classification. Bundling them is the point — this is the seam that lets `adapter.ts` be tested without network.
- [x] `adapter.ts` reduces to the `ProviderPort` class: composition only.
- [x] Test `adapter.ts` against a stubbed `http.ts`, with no real socket.
- [x] Confirm no behaviour change beyond the seven fixes; tests stay green throughout.

### T4A — Tool Advertisement *(blocks every live tool call)*

**The model is currently never told the tools exist.** `ToolDefinition` and `ToolExecutorPort.definitions()` were dropped during the T2R/T3R refactors, `ProviderRequest` has no `tools` field, and `buildOpenAIChatCompletionsRequestBody` sends only `model`, `stream`, `messages`, and `max_tokens`. So no real provider can emit a tool call, and the tool half of the loop is reachable only from the scripted provider, which fabricates calls directly. Every tool test passing is therefore compatible with tool calling being impossible in production.

Design: `design.md` Decision 11.

- [ ] Restore a first-class tool concept: `name`, `description`, parameter schema, `mutating`. Tools declare; the executor builds and runs.
- [ ] Define zod schemas for all six tools, with a `.describe()` on every field. Field descriptions are prompt surface, not just validation — they are how the model learns to call the tool.
- [ ] Derive the wire JSON Schema with `z.toJSONSchema()`, stripping the `$schema` key before sending.
- [ ] Derive TypeScript param types with `z.infer`, so a handler cannot disagree with its own schema.
- [ ] Add `tools: readonly ToolDefinition[]` to `ProviderRequest` so definitions reach the adapter.
- [ ] Serialize into the chat-completions body as `tools[].function.{name,description,parameters}`.
- [ ] Validate input against the schema before writing `tool.requested`, for both provider-supplied and policy-modified input, failing the call rather than the turn (B10).
- [ ] **Keep schema validation out of the adapter** (Decision 12). The adapter validates the wire — parseable arguments, finish-reason agreement — which fails as `protocol` and kills the step. Schema validation belongs to the tool layer and fails as `tool.result.failed`, which the model can retry. Putting it in the adapter turns a model typo into a dead turn.
- [ ] Add `--inspect-provider` to `scripts/e2e-turn.mjs`: print the serialized request body and exit without calling the provider.
- [ ] Test: the serialized body carries all six tools, each with a non-empty description and an object schema.
- [ ] Test: a malformed tool input fails the call with `POLICY_INVALID_INPUT` or a schema error, and the turn continues.
- [ ] Live: confirm a real model actually calls a tool through the LiteLLM lane.

### T4B — Per-Adapter Checklist

These items are per adapter, not global. One shared checkbox cannot express "done for chat-completions, pending for Anthropic", which is how required work gets marked complete early.

`OpenAIChatCompletionsAdapter` — `/v1/chat/completions` SSE:

- [x] Implemented with `fetch` and direct SSE parsing. No vendor SDK.
- [x] Tool-call assembly per call id; `tool-call-complete` only on successful parse.
- [x] Stop-reason mapping to `CompletionReason`; unknown reasons become `failed: protocol` events rather than thrown errors.
- [x] Finish-reason/tool-call agreement (B3): `stop` with pending calls and `tool_calls` with zero calls both fail as `protocol`.
- [x] Failure classification with `retryable` set deliberately; 429 and 400 asserted.
- [x] Verified live against LiteLLM `/v1/chat/completions`.
- [x] Smoked against local Ollama `/v1/chat/completions`. Transport proven; content quality not.
- [ ] Serialize tool definitions into the request body (T4A).
- [ ] Emit usage where the live stream or fixture contains it.
- [ ] Abort leaves no dangling reader — a test that would otherwise hang.
- [ ] History translation covers tool requests and tool results, not just text.

`AnthropicMessagesAdapter` — `/v1/messages` SSE:

- [ ] Implement the adapter. Direct Anthropic API is `truth`; Bedrock-through-LiteLLM is compatibility/deployed-environment evidence.
- [ ] Tool-call assembly per call id; `tool-call-complete` only on successful parse.
- [ ] Stop-reason mapping; unknown reasons become `failed: protocol` events.
- [ ] Finish-reason/tool-call agreement (B3).
- [ ] Failure classification with `retryable`; assert 429 and 400.
- [ ] Serialize tool definitions as `tools[].{name,description,input_schema}`.
- [ ] Emit usage.
- [ ] Abort leaves no dangling reader.
- [ ] History translation covers tool requests and results.
- [ ] Verify against a configured lane.

### T4C — Cross-Adapter Work

- [ ] **Parser conformance suite** in `test/conformance/`, parameterised over `(parser, streamBytes)`: feeds recorded or inline bytes through the parser and asserts the event sequence under adversarial chunkings — one byte at a time, split mid-SSE-event, **split mid-UTF8-multibyte-character**, and all at once. Asserts no `tool-call-complete` without parseable input, exactly one terminal event, nothing after it.
- [ ] Retry with backoff, jitter, and `retry-after`, only before the first emitted event of a step (B12). State the approach in the adapter.
- [ ] Live smoke tests for all configured lanes, excluded from the default run.
- [ ] Update `research/s1-findings.md` from live observations; reconcile the port against reality and record any change it forced.
- [ ] `OpenAIResponsesAdapter` for direct OpenAI `/v1/responses` is deferred to v1.x unless the adapter matrix changes again.

### T4F — Optional: fixture capture harness

Genuinely optional. The capture proxy preserves observed streams as regression evidence; it does not block adapter work. The proxy stays provider-agnostic: local HTTP from CLI/curl/test driver to proxy, HTTPS from proxy to upstream, credentials forwarded from the driving request, raw upstream bytes recorded.

- [x] Add stdlib-only Python capture proxy at `scripts/capture-provider-streams.py`.
- [x] Record request body, request headers, response status, response headers, raw streaming bytes, duration, provider, case, upstream, and rewrite result.
- [x] Add fixture labels to capture metadata: `source`, `wire`, `purpose`, `backend`, `model`, and `apiVersion`.
- [x] Scrub credential-bearing headers and auth-like JSON request fields before writing fixture metadata/body files.
- [x] Preserve streaming behavior with `read1()` rather than buffering the whole response.
- [x] Support `truncated-tool-json` by rewriting `max_tokens` / `max_output_tokens` to a small value.
- [x] Document Claude Code and Codex CLI capture flow in `fixtures/README.md`.
- [x] Add a LiteLLM gateway smoke path for OpenAI-compatible streaming fixtures when direct provider API keys are unavailable.
- [x] Ignore raw generated fixture captures under `fixtures/providers/` so captured requests, responses, and headers are not accidentally committed.
- [x] Verify LiteLLM model listing, direct streaming, and proxy capture with a fresh company gateway key.
- [x] Probe LiteLLM model metadata and streaming routes; record that Bedrock Claude, GPT, and Mistral share `/v1/chat/completions`, while Bedrock Claude also streams through `/v1/messages`.
- [ ] Capture Anthropic fixtures through native Anthropic or verified LiteLLM `/anthropic/*` pass-through: `interleaved`, `truncated-tool-json`, `context-limit`, `refusal`.
- [ ] Capture `interleaved` and `truncated-tool-json` for OpenAI-compatible `/v1/chat/completions`.
- [ ] Label translated LiteLLM routes as `compatibility` or `deployed-environment`, never native provider `truth`.
- [ ] Install/verify Claude Code CLI and capture one proxy smoke request against Anthropic.
- [ ] Install/verify Codex CLI base-URL routing and capture one proxy smoke request against OpenAI.

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

## Architectural Debt — Forked Provider-History Reducer

Accepted knowingly on 2026-09-11. Recorded because it is invisible from the protocol package and will not announce itself later.

**What it is.** `src/session-provider-history.ts` is a 172-line near-verbatim fork of the protocol's 213-line `reduceProviderHistory`, differing in one behaviour: it omits the `OutOfOrder` sequence check. It exists because provider history must be session-scoped (B11) while durable `sequence` is assigned globally, so any session view has gaps that the protocol reducer reports as errors.

**Why it is debt rather than a design.** Decision 2, point 4 rejects exactly this: *"that reducer is already the definition of model-visible history; a parallel type would drift from it."* A parallel reducer is worse than a parallel type, because the drift is behavioural and silent. There are now two definitions of model-visible history, and only one is reachable from the protocol package.

**How it fails.** Its `default: return` ignores unknown record types without raising an issue. When a new record type becomes model-visible and `reduceProviderHistory` learns to handle it, the fork silently will not. No error, no failing test — the model just stops seeing something it should. `ProviderHistory.lastSequence` has also diverged in meaning: `Math.max(...)` here versus a contiguous count in the protocol, and both are typed `ProviderHistory`, so the compiler cannot help.

**Trigger conditions — whichever arrives first is the deadline:**

- **Milestone 5** adds the durable token-usage record (see `design.md`, Known Gap). That is a protocol change touching `reduceProviderHistory`, and the fork must be gone before it lands.
- **Milestone 7** needs hydration. `recordsBySession` in `RecordEmitter` is an in-memory index that does not survive a restart, so hydration would have to rebuild it by scanning and filtering the global log — reintroducing the pattern B11 removed, with persistence pressure on top.

**The fix, and why it should cost nothing.** The first file-backed `DurableSink` is required by Milestone 7 regardless, and today no file-backed sink exists at all — `MemoryDurableSink` is the only implementation and it lives in `testing.ts`. Build that first sink **session-scoped**, one log per session, which is what `JsonlSessionLogWriter` already names. Then sequences are gapless within a session, `reduceProviderHistory` works unmodified, the fork is deleted, and hydration becomes "read this session's log."

Framed as "replace the reducer" this is rework. Framed as "never build the global sink" it is free. Do not build a global file-backed sink in the meantime.

One wrinkle to settle when that work starts: `conversation.created` spans sessions, so it needs a home — the first session's log, or a small conversation-level log.

**Containment until then:**

- [x] Do not extend `session-provider-history.ts`. Any new model-visible record type is a signal to do the session-scoped sink, not to grow the fork.
- [x] Keep it internal — removed from the `src/index.ts` barrel export so it cannot become a downstream dependency. Only `provider-step-runner.ts` may import it.
- [ ] Delete it as part of the session-scoped durable log work, before Milestone 5's protocol change or Milestone 7's hydration.

## T4E — End-to-End Runner Spike

Nothing has run end to end. All tests exercise components in isolation: the adapter against recorded and live streams, the loop against the scripted provider, the tools against temp directories. The four have never run in the same process, and no program exists to start them.

This spike answers the question Milestone 3 exists to answer — does the Milestone 2 contract survive a real provider *and* real tools *and* the real loop, together — before T5 builds a transport and renderer on top.

- [x] `scripts/e2e-turn.mjs`: compose the real adapter, real workspace tools, an ask-on-shell policy, real ids and clock, and a console live sink; submit `conversation.create`, `session.create`, `turn.submit` against a real repository.
- [x] Use `MemoryDurableSink`. **Do not build a file-backed sink for this spike** — that decision belongs with the session-scoped log work above, and making it here under time pressure is how the global version gets built by accident.
- [ ] Approval prompt on stdin, resolving through a concurrent `engine.submit` while the turn is in flight. This is the first real exercise of the concurrent-command path from B8.
- [x] Recorded in `research/e2e-spike.md`. Found: transport failures are not classified — raw `fetch failed` escapes the port, losing `retryable` and `ProviderFailure.kind`.
- [x] Fix transport-failure classification in the chat-completions adapter; confirm non-2xx is classified too (429 retryable, 400 not).
- [ ] Run one live turn through the LiteLLM lane with tools and an approval prompt. The concurrent-approval path (B8) is still unproven.
Expect more integration bugs as the live lane runs. That is the point of the spike, not a sign it went badly.

## Spikes During This Milestone

- [ ] S2 — classify `edit` exact-match failures against real model output. T3's error codes are the raw data. Feeds Milestone 6.
- [ ] S4 — measure quality degradation against context fill on a multi-file task. Feeds Milestone 5.

## Close-out

- [ ] Validate OpenSpec change.
- [ ] Update `ROADMAP.md` Milestone 3 status.
- [ ] Carry the token-usage protocol gap (`design.md`, Known Gap) into the Milestone 5 change.
