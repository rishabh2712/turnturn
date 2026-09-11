# Design: Sequential Agent Loop

Milestone 3. Scope lives in `ROADMAP.md`; this file holds decisions only.

Status: approved 2026-09-10. Implementation is in progress; an earlier unreviewed attempt was removed so the design could be validated first.

## What This Milestone Proves

That the Milestone 2 protocol contract survives contact with a real provider and real tools. One narrow path end to end: a real repository, a model, a tool call, an edit on disk.

## Decision 1: Ports, Not Callbacks

The engine talks to the outside world through seven injected ports. It holds no renderer callbacks, no shared client memory, no provider-native state, and passes no object references across a boundary.

```ts
ProviderPort      // model steps
ToolExecutorPort  // tool execution
ToolPolicyPort    // allow / deny / ask before execution
DurableSink       // persists records, assigns sequence
LiveSink          // publishes ephemeral events
EngineIds         // uuid(), injected so tests are deterministic
EngineClock       // now(), same reason
```

Why: the Milestone 2 contract already separates durable records from live events, so the engine should depend on those types directly rather than inventing a callback API. Ports cost more test plumbing than a direct `run(input)` function, and buy the transport shape immediately.

## Decision 2: The Provider Port Shape

This is the part most worth reviewing, because everything else depends on it.

```ts
interface ProviderPort {
  readonly name: string;
  run(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

type ProviderEvent =
  | { type: "text-delta";                  text: string }
  | { type: "reasoning-delta";             text: string }
  | { type: "tool-call-start";             callId: string; name: string }
  | { type: "tool-call-arguments-delta";   callId: string; text: string }
  | { type: "tool-call-complete";          call: ProviderToolCall }
  | { type: "usage";                       usage: ProviderUsage }
  | { type: "completed";                   reason: CompletionReason; usage?: ProviderUsage }
  | { type: "failed";                      error: ProviderFailure };

type CompletionReason = "complete" | "tool-use" | "output-limit" | "refused" | "cancelled";

interface ProviderFailure {
  kind: "transport" | "request-rejected" | "protocol" | "interrupted" | "context-limit";
  message: string;
  retryable: boolean;
  status?: number;
}
```

Four choices to check:

1. **`usage` is in the port.** Milestone 5 enforces a context budget and Milestone 8 shows cost. Both need token counts, both providers stream them. Leaving usage out would force a port change two milestones later.
2. **`"tool-use"` is a completion reason.** A turn stopping to run tools is a different terminal state from a turn that finished talking, and the loop branches on exactly this.
3. **`"context-limit"` is its own failure kind.** It arrives as a pre-stream rejection and Milestone 5 needs to distinguish it from a generic rejection.
4. **Request history is `ProviderHistory`** from `reduceProviderHistory`, not a new message type. That reducer is already the definition of model-visible history; a parallel type would drift from it.

Two rules the adapter owns:

- **Nothing provider-shaped escapes.** No SSE, no provider event names, no provider finish-reason strings. `ProviderStepCompleted.stopReason` is a free-form string in the protocol; persist the canonical `CompletionReason` into it, never the raw provider value.
- **`tool-call-complete` fires only after arguments parse.** A truncated tool call ends as `completed: "output-limit"` or `failed: "interrupted"`. A parse error must never reach the engine. This is the behaviour a naive adapter gets wrong.

## Decision 3: Five Policy Outcomes, Two Approval Decisions

The protocol's `ApprovalDecisions` enum has only `Allow` and `Deny`. The milestone requires five policy outcomes. These are not in conflict — the five are policy-port outcomes, and only the human-facing question collapses to two.

```ts
type PolicyDecision =
  | { kind: "allow" }
  | { kind: "allow-modified"; input: JsonValue }
  | { kind: "deny";           error: SerializedError }
  | { kind: "ask";            reason: string }
  | { kind: "abort";          error: SerializedError };
```

| Decision | Records written | Terminal tool status |
| --- | --- | --- |
| `allow` | execute immediately | `completed` / `failed` |
| `allow-modified` | execute with replaced input; `tool.requested` records the modified input | `completed` / `failed` |
| `deny` | `tool.result.denied` | `denied` |
| `ask` | `approval.requested`, wait, `approval.resolved`; then execute or deny | per resolution |
| `abort` | `tool.result.aborted`, then fail the turn | `aborted` |

Do not widen the protocol enum. `abort` and `allow-modified` resolve inside the engine before an approval exists.

## Decision 4: Tools Fail as Outcomes, Not Exceptions

`ToolExecutorPort.execute` returns `{ kind: "completed" | "failed" }` and does not throw for tool-level failure. A missing file is a `failed` outcome. A thrown error means the executor itself is broken and fails the turn.

This is the mechanism behind "recoverable tool errors stay inside the loop": a `failed` outcome becomes `tool.result.failed` and the loop continues to the next provider step with that error as the tool result. Only `abort`, provider failure, and cancellation end a turn early.

A non-zero shell exit is a **`completed`** outcome carrying the exit code — the model needs to read the compiler error. `failed` means the command could not be run at all.

## Decision 5: Sequential Execution, Strictly Ordered

One tool at a time, in `providerOrder`. Parallel waves are v1.x, because the real scheduler requirements only become visible once sequential execution has run against real workloads.

Sibling isolation still applies: when one tool in a step fails or is denied, completed siblings keep their results and remaining siblings still get terminal records.

## Decision 6: Durable Before Live

Persist the record, then publish the matching terminal live event. A renderer must never learn a terminal fact that is not yet durable.

Non-terminal live events — `content.delta`, `tool.progress`, `stdout.delta` — have no durable counterpart and stream freely. `LiveSink.publish` is fire-and-forget and never awaited; a slow or throwing subscriber cannot stall or break a turn.

Consequence: assistant text is durable only as one `AssistantMessageCompleted` record carrying the whole string. Deltas are never durable. Replay reconstructs the message, not the typing.

## Decision 7: The Renderer Subscribes Through the Transport

Not directly to the engine's `LiveSink`. Every command and event round-trips through `serializeJson` and `JSON.parse`, even in-process, even in tests.

This costs plumbing before anything renders. It buys the guarantee that a non-serializable value fails loudly rather than after a transport exists, and it stops the renderer depending on object identity that will not survive a real boundary.

Resume is by durable record `sequence`, never by live-event id. A resuming subscriber gets the durable records it missed but not the live events — the completed assistant message is how it recovers the text.

## Decision 8: Live Provider Adapters, Wire Format First

`ProviderPort` is designed against multiple provider wire shapes so the interface is not shaped by whichever adapter is written first. T4 builds live adapters for direct Anthropic, direct OpenAI, LiteLLM, and local Ollama lanes.

Model brand does not choose the adapter. Wire format chooses the adapter:

```text
Anthropic native /v1/messages SSE       -> AnthropicNativeAdapter
OpenAI native /v1/responses SSE         -> OpenAIResponsesAdapter
LiteLLM /v1/chat/completions SSE        -> LiteLLMChatAdapter
Ollama chat/generate streaming          -> OllamaChatAdapter
```

A parser **conformance suite** is derived from the first adapter and reused for every later wire parser. The suite can run against inline samples, live-captured bytes, or durable fixtures; fixture availability is not an implementation gate.

Model routing and automatic fallback stay v1.x. Two adapters is not the same capability as choosing between them.

## Decision 9: The Scripted Provider Stays

It is the default test double for every loop-invariant test, and the deterministic suite is the engine correctness gate. Real adapters have parser tests that do not require network plus live smoke tests that stay out of the default run.

## Decision 10: The Protocol Is Frozen This Milestone

No adding, renaming, or widening a protocol type to make engine code easier. A protocol change is contract-altering and needs its own change with full research.

Master invariant: `reduceEngineState(records).issues` must always be empty. That reducer already validates duplicate entities, missing parents, invalid transitions, and ordering. Derive legal record ordering from it, not from prose — where this design and the reducer disagree, the reducer is right.

## Decision 11: Tools Are First-Class, With Zod as the Single Source of Truth

### The problem this fixes

Tool advertisement does not exist. `ToolDefinition` and `ToolExecutorPort.definitions()` were dropped during the T2R/T3R refactors, `ProviderRequest` has no `tools` field, and the chat-completions request body carries only `model`, `stream`, `messages`, and `max_tokens`.

The model is therefore never told the tools exist, so no real provider can emit a tool call. The tool half of the loop is reachable only from the scripted provider, which fabricates calls directly. Every tool test passing is compatible with tool calling being impossible in production — which is exactly the class of gap the end-to-end spike exists to find, and it would have surfaced on the first live run.

### Tools declare, build, then execute

Follow gemini-cli's two-phase shape (`BaseDeclarativeTool` → `ToolInvocation`, in `gemini-cli/packages/core/src/tools/tools.ts`):

1. **The tool** owns its name, description, parameter schema, and `mutating` flag, and validates raw input.
2. **The invocation** holds validated, typed params and knows how to describe itself and run.

Why this shape rather than one flat `execute(name, input)`:

- It gives the schema a home. Without one there is nowhere to put the thing the provider needs.
- Validation happens once, before execution, at a single choke point — which is what B10 requires.
- `describe()` belongs to the invocation, so approval prompts render from validated params instead of each caller re-deriving a summary. The e2e runner currently hand-rolls that, which is the smell.

### Zod is the source of truth, not JSON Schema

Each tool declares a zod object schema with a `.describe()` on every field. From it:

- the wire schema via `z.toJSONSchema()`, and
- the TypeScript param type via `z.infer`.

**Descriptions are prompt surface, not documentation.** Field descriptions are how the model learns to call the tool correctly, so they are written for a reader and reviewed like prompt text.

Gemini hand-writes JSON Schema and validates it with AJV. We do not copy that, for three reasons:

- `zod@4.5.4` is **already a dependency** and already used in `packages/protocol/src/session-log.ts`. AJV would be a new dependency for a capability we have.
- Zod 4 ships native `z.toJSONSchema()`, which did not exist when gemini's tool layer was written. Verified output is clean draft-2020-12 with `properties`, `required`, `description`, and `additionalProperties: false`.
- One artifact instead of two. Hand-written JSON Schema plus a separate TypeScript type can disagree with each other and with the handler; `z.infer` makes that a compile error.

Two mechanical notes:

- **Strip the `$schema` key before sending.** `z.toJSONSchema()` emits it; providers do not want it.
- Two wire shapes from one schema: OpenAI-compatible `tools[].function.{name,description,parameters}`, Anthropic `tools[].{name,description,input_schema}`. The adapter owns that translation — the tool never knows which provider it is talking to.

### Validation boundary

The engine validates input against the declared schema **before** writing `tool.requested`, for both provider-supplied and policy-modified input. A violation is `tool.result.failed`, not a turn failure, per B10. The executor still validates what only it knows — path exists, pattern compiles — and returns a `failed` outcome.

This keeps Decision 4 intact: schema violations and semantic failures are both outcomes, and a throw still means a broken executor.

## Decision 12: Provider Adapter Layering, and Where Validation Lives

### Not justified by file length

Worth stating up front, because the weak version of this decision will erode:

| Reference file | Lines |
| --- | --- |
| codex `core/src/client.rs` | 2,744 |
| gemini `core/geminiChat.ts` | 1,881 |
| gemini `core/client.ts` | 1,299 |
| turnturn `providers/openai-chat-completions.ts` | 383 |

codex's client mixes session state, WebSocket fallback, WebRTC, auth, telemetry, and routing in one file. Neither reference practises small-file discipline in the provider layer. "Split it because it is long" is therefore unsupported, and a rule with no real backing gets ignored the next time someone is in a hurry.

### Justified by making the state machine separately constructible

Gemini externalises stream translation in `gemini-cli/packages/core/src/agent/event-translator.ts`:

```ts
interface TranslationState { streamId; streamStartEmitted; model; eventCounter; pendingToolNames }
createTranslationState(streamId?): TranslationState
translateEvent(event, state): AgentEvent[]
mapFinishReason(...)  // pure
mapUsage(...)         // pure
mapError(...)         // pure
```

One frame in, zero or more events out, state explicit and inspectable, pure mappers beside it.

This is the whole argument. The stream edge cases that matter — usage after finish, `tool_calls` with no calls, `stop` with pending calls, `[DONE]` after finish, stream ending without `[DONE]` — are currently reachable only by constructing an async byte iterator and collecting what comes out. With explicit state and a per-frame function each becomes a three-line unit test. Adopt the shape, not merely the file split.

### The validation boundary

The two validations have different consequences, which is what makes conflating them expensive.

| Layer | Validates | Failure | Blast radius |
| --- | --- | --- | --- |
| Adapter | wire well-formedness: parseable JSON arguments, finish-reason agreement | `failed: protocol` | kills the step |
| Tool layer | input matches the declared schema | `tool.result.failed` | recoverable; the model retries |

Put schema validation in the adapter and a model typo in tool arguments kills the turn instead of letting the model correct itself. Small architectural slip, large behavioural difference.

Gemini draws the line in the same place:

- `tools/tool-registry.ts` `getFunctionDeclarations()` owns the wire declarations.
- `tool.build(args)` validates, called from `scheduler/scheduler.ts:388` and `core/turn.ts:492`.
- `agent/event-translator.ts` contains **zero** references to `validate` or `schema`.

Stronger still for B10: `scheduler/confirmation.ts:257` and `scheduler/hook-utils.ts:89` call `tool.build(result.updatedParams)` — re-validating *after* a confirmation or hook modified the parameters. That is exactly our `allow-modified` outcome, so "validate policy-modified input" is the established shape rather than a local invention.

### Layout

```text
packages/assistant-core/src/providers/
  sse.ts
  openai-chat-completions/
    adapter.ts     ProviderPort class; composition only
    request.ts     body + headers; later tools + tool_choice
    history.ts     ProviderHistory -> chat messages
    frames.ts      raw SSE data -> typed frame; safe reads over untrusted JSON
    translate.ts   TranslationState + translateFrame(frame, state) -> ProviderEvent[]
    tool-calls.ts  delta accumulation, start detection, completeness
    http.ts        fetch wrapper + HTTP failure classification
    index.ts       narrow facade: adapter, options, ollama preset
```

```text
packages/assistant-core/test/
  providers/
    sse.test.mjs
    openai-chat-completions/
      {history,frames,translate,tool-calls,request,adapter}.test.mjs
  conformance/
    parameterised (adapter, fixtures) suite only
```

Notes on the shape, in order of how easily each gets eroded:

- **`frames.ts` exists so the translator is not doing JSON archaeology.** Something has to turn an untrusted `data:` payload into a typed frame and give the `[DONE]` sentinel a typed home. Without it, `translateFrame` still reaches into raw records.

- **`http.ts` bundles the fetch wrapper with failure classification.** An earlier version of this decision rejected a separate file on the grounds that classification is eight lines. That was wrong: bundled with the fetch, this is the seam you stub to test `adapter.ts` without network, which is worth a file on its own. Expect it to duplicate into the Anthropic adapter and merge later — that is the one-adapter-deep path below, working as intended.

- **`index.ts` is a narrow facade, never `export *`.** Export the adapter class, its options type, and the Ollama preset. Nothing else. Precedent: `session-provider-history.ts` reached the public API through `src/index.ts` and had to be deliberately un-exported to contain it. A folder barrel that re-exports everything puts `frames.ts`'s untrusted-read helpers and the tool-call assembler's internals into the package surface, after which removing them is a breaking change. Tests deep-import internals; that is normal and keeps the surface intentional.

- **No generic `json.ts`.** The `objectField` / `stringField` helpers are not JSON utilities, they are safe reads over untrusted provider output. They live in `frames.ts`, where that is the job. A file named `json.ts` becomes a junk drawer.

- **`test/conformance/` means a gate, not a location.** It holds only the parameterised fixture-driven suite from T4C — the thing every adapter must pass. Per-file unit tests go under `test/providers/`. Keeping that distinction matters precisely when the second adapter arrives, which is the reason the suite exists.

- **One adapter deep.** No shared `providers/base/` until the Anthropic adapter exists and the common part is observable. Two implementations is when an abstraction earns itself; guessing now produces a base class that fits neither.

The test of whether this decomposition is real: each known defect maps to exactly one file. It does — see T4R in `tasks.md`.

### Ollama Is a Preset, Not an Adapter

`OllamaChatCompletionsAdapter` is 33 lines that delegate every call. Its entire behaviour is: default `baseUrl` to `http://127.0.0.1:11434`, omit the auth header, and rename itself. Same wire, same frames, same translation, same tool-call assembly.

Decision 8 says wire format chooses the adapter, not model brand and not deployment. Ollama is a deployment. A class, an options interface, and an 84-line test file exist to express two default values.

There is also a correctness cost. `ProviderPort.name` feeds `session.created.provider`, so the durable record currently asserts the wire contract is `ollama-chat-completions` when it is `openai-chat-completions`. A durable record should not claim something untrue about the protocol.

Replace with a factory exported from the folder facade:

```ts
export const ollamaChatCompletions = (options: Omit<Options, "baseUrl"> & { baseUrl?: string }) =>
  new OpenAIChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:11434", ...options });
```

Wanting the lane visible in telemetry is legitimate, but that is a **deployment label**, not adapter identity. It belongs where fixture metadata already puts it — `source` and `backend` — and `name` stays truthful about the wire.

## Behavioral Contracts

Resolved 2026-09-11 from design review. Numbered as raised, for traceability. Where the reducer in `packages/protocol/src/engine-state.ts` decides a question, that is stated — those are facts, not preferences.

**B1 — Assistant text is durable at step end.** Accumulate deltas, write `assistant.message.completed` if non-empty, then the step's tool requests and terminal record. Forced: `updateTurn` raises `InvalidTransition` for a non-`Running` turn, so the message cannot follow any terminal turn record. On step failure, write the accumulated text *before* `provider.step.failed` — the user already saw those deltas, and the log must not contradict the screen.

**B2 — Tool requests are written lazily, per tool, in `providerOrder`.** For each call: policy → `tool.requested` → approval if needed → execute → terminal result, then the next. Consequence: if one tool aborts the turn, later siblings never get a `tool.requested`, so there is nothing to terminate and the invariant holds trivially. No synthetic aborted records for tools that were never requested. Provider history stays consistent because it is built from `tool.requested` records, not from assistant message content.

**B3 — Provider completion requires agreement.** Tool calls emitted ⇒ reason must be `"tool-use"`. Reason `"tool-use"` ⇒ at least one complete tool call. A contradictory stream is `failed: { kind: "protocol" }`. Choosing a winner silently would hide adapter and provider bugs at the one point the engine branches.

**B4 — Truncated tool-call JSON, by finish reason.**

| Stream ended | Finish reason | Arg buffer | Adapter emits |
| --- | --- | --- | --- |
| cleanly | output-limit | invalid | `completed: "output-limit"`, no `tool-call-complete` |
| cleanly | tool-use / complete | invalid | `failed: { kind: "protocol" }` |
| cleanly | refused | invalid | `completed: "refused"` |
| aborted via signal | — | invalid | `completed: "cancelled"` |
| connection dropped | absent | either | `failed: { kind: "interrupted" }` |

A finish reason means the provider chose to stop, so trust it. No finish reason means interrupted. A clean finish claiming a complete call with invalid JSON is a lie and must be loud.

**B5 — Cancellation ordering.** There is no durable record for the cancellation request; commands are not records. The audit trail is the `commandId` carried on every record the cancel caused. A tool that finishes after cancellation records `tool.result.completed` with `cancellation: { requested: true, reason }` — forced, because `ToolResultAborted` has no `cancellation` field while `Completed` and `Failed` do. **First terminal write wins**: `updateToolTerminal` rejects a second terminal record, so the engine claims a tool call's terminal slot atomically. Cancellation during streaming writes `provider.step.failed` with code `TURN_CANCELLED` (`retryable: false`, `fatal: false`) — the step produced no usable output, and a `Completed` status would read as success in the timeline.

**B6 — `tool.cancel` cancels one call; the turn continues.** Result is `tool.result.aborted` with `synthetic: true`. Remaining siblings still run, and the aborted result is model-visible so the next step tells the model what happened. `turn.cancel` ends the turn: abort the step or running tool, give every requested-but-unterminated call an aborted result, then `turn.aborted`.

**B7 — Idempotency is per conversation, in memory, for one process lifetime.** Keyed `(conversationId, idempotencyKey)`. Same key with a different command `type` is `rejected` with a conflict code, never silently served. A duplicate arriving while the first is in flight awaits the *original promise* and returns its outcome — store the promise, not just the records. A `rejected` command does not consume its key. After restart the map is gone; accepted for Milestone 3. Milestone 7 can rebuild a `commandId`-keyed index at hydration because records carry `commandId`, but an `idempotencyKey`-keyed one cannot be rebuilt — the key is never persisted, and persisting it is a protocol change.

**B8 — Serialize appends, not commands.** One append mutex per durable log (forced: the reducer demands `sequence === lastSequence + 1`, so one ordered appender, which also gives durable-before-live ordering for free); a per-turn lock for claiming terminal state; approval waiters as independent promises. Serializing whole commands deadlocks — `turn.submit` does not resolve until the turn ends, which needs the approval command the queue would be holding behind it. Different conversations run fully concurrently.

**B9 — Policy runs before `tool.requested`.**

```text
provider tool call -> policy -> tool.requested (modified input, requiresApproval) -> approval.requested -> execute
```

Forced twice over: `addTool` derives initial tool status from `payload.requiresApproval`, so that field must be known at request time; and `addApproval` raises `MissingParent` unless the tool already exists. Recording the original input and modifying later is not merely lossy, it is illegal.

**B10 — An invalid policy modification fails the tool call, not the turn.** The engine validates `allow-modified` input against the tool's declared `inputSchema` before writing `tool.requested`; on violation it writes `tool.result.failed` with code `POLICY_INVALID_INPUT` and `synthetic: true`, and the loop continues. Same rule for provider-supplied input. A buggy policy must not destroy the user's work, and trusting it would hand garbage to a tool. Split of responsibility: the engine validates against the declared schema because it owns that schema as provider-facing contract; the executor validates what only it knows — path exists, pattern compiles — and returns `failed`.

**B11 — Provider history is session-scoped.** All records for the current `sessionId`, in sequence order, snapshotted when the step starts. Not the whole sink, not the conversation. A session is one provider-bound run — `SessionCreated` carries the provider — and that is what maps to one model conversation; a conversation may hold several. The engine keeps a per-session record list; the sink is never a global source.

**B12 — Retry only before the first emitted event of a step.** Once any `ProviderEvent` is yielded, a failure is terminal for that step. No buffering, so streaming survives; no duplicate events, so no bookkeeping. Mid-stream recovery needs provider continuation support and is out of scope.

**B13 — Live-sink failures are swallowed, never re-published.** Publishing a warning through a broken sink can fail too. Diagnostics go to an optional `onSinkError` dependency defaulting to a noop, itself wrapped so a throwing diagnostic cannot escalate.

**B14 — Transport backpressure: records never dropped, events bounded.** Ephemeral events use a bounded queue; overflow drops deltas and emits at most one gap warning per overflow episode, with a queue slot reserved for it — otherwise the notification about a full queue cannot get through the full queue.

**B15 — Resume snapshots under the append mutex.** `subscribe` takes the same lock as the appender; while holding it, it captures `lastSequence` and registers the subscriber, then releases. Records at or below the snapshot come from the log, records above it from the live feed. No gap, no duplicate, and it reuses the lock B8 already requires.

**B16 — One shared tool output envelope.** `{ content: string; truncated: boolean; originalBytes?: number }`, identical across all six tools, because it becomes model-visible history. UTF-8 **bytes**, not characters. Shared 64 KiB default, overridable per tool. `read`, `glob`, `grep` retain the head; `shell` retains the **tail**, because errors are at the end. Truncation always inserts an explicit marker stating how many bytes were dropped.

**B17 — `shell` is ask-always and unconfined.** `read`/`glob`/`grep` allow; `write`/`edit` allow inside the workspace with the diff shown; `shell` requires approval every time, with no allow-list until Milestone 4. Environment is a minimal allow-list — `PATH`, `HOME`, `LANG`, `TERM=dumb` — never the inherited parent environment, or credentials in it leak into every command. cwd is the workspace root. Stated plainly because it must not be misread: **path confinement protects the file tools only. A shell command can `cd /` and read anything.** Policy is not containment. That is exactly why it is ask-always until Milestone 4's sandbox.

**B18 — S1 is evidence, not a gate.** T1–T3 and T5 proceed against the scripted provider. T4 proceeds live-first against configured provider lanes. Milestone 3 is not *done* until at least one real adapter has a passing parser/conformance suite and a live smoke path, because a scripted provider only validates the contract against our own assumptions. Captured fixtures strengthen regression coverage, but absence of a fixture must not block starting or implementing an adapter.

## Fixture Sources

Model brand does not define adapter truth. **Wire format does.** A fixture is labelled by the bytes on the wire, never by the model that produced them. Fixtures preserve observed bytes for repeatable parser tests; live calls provide release confidence and discovery.

Every fixture records:

```json
{
  "source": "direct-provider | litellm-passthrough | litellm-unified | ollama | scripted | synthetic",
  "wire": "anthropic-messages | openai-responses | openai-chat-completions | ollama-ndjson",
  "model": "<exact provider model id>",
  "purpose": "truth | compatibility | smoke | deterministic",
  "capturedAt": "<ISO-8601>",
  "apiVersion": "<provider version header>"
}
```

`capturedAt` and `apiVersion` are not optional metadata. Wire formats drift, so fixtures are perishable and need periodic re-capture — they are not a one-time cost.

Which source proves what:

| Source | Proves | Does not prove |
| --- | --- | --- |
| Scripted `ProviderEvent` | engine correctness | anything about a wire format |
| Captured native bytes | adapter correctness for that wire | behaviour of any other wire |
| Gateway pass-through | adapter correctness, *if* the upstream is verified | anything, if the gateway translates |
| Gateway unified/translated | gateway compatibility | provider truth — the gateway is the author |
| Local model | the loop runs offline | provider truth, unless the wire matches exactly |
| Live call | nothing repeatable; release confidence only | anything in CI |

**A gateway that translates is a normalizer, and normalizers eat edge cases.** The four S1 cases — interleaved deltas, truncated tool JSON, mid-stream refusal, context-limit — are precisely the shapes most likely to be smoothed, synthesized, or swallowed in translation. Translated captures are weakest exactly where the fixtures are needed most, so they may be recorded as `purpose: "compatibility"` but never as `truth`.

Compatibility captures still earn their place: run them through the *same* adapter under the conformance suite, where divergence is recorded as a finding rather than gating the build.

## Known Gap

There is **no durable record for token usage** in the Milestone 2 contract. Milestone 5 cannot enforce a context budget without one. Not filled here, because that is a protocol change. Milestone 5 must design it.

## Prior Attempt, Removed

An implementation of Decisions 1, 2, 4, 6 and part of the loop existed and was deleted on 2026-09-10, unreviewed. Two reasons, both worth knowing before the next attempt:

- It was written with line breaks removed — one 1,320-character line held the entire tool-execution loop. The repo has no formatter config, so nothing prevented it. Add one before restarting.
- It never called `ToolPolicyPort`. Approvals, cancellation, and the race behaviour — the hard half of Decision 3 and the loop — were absent, and cancel/approval commands returned `UNIMPLEMENTED`.

The port definitions it produced matched this design and are reproduced above.

## Open Questions

- Does the OpenAI adapter land in this milestone or Milestone 8 with its auth surface? Sequencing only.
- Is v1.x parallel-wave work still bound by the Milestone 2 sibling-ordering contract once real tools exist?
