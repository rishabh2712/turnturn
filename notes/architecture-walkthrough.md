# turnturn: An Architecture Walkthrough

Written 2026-09-11. About a 30-minute read.

**This note teaches; it does not decide.** `ROADMAP.md` owns scope, and
`openspec/changes/implement-sequential-agent-loop/design.md` owns decisions. If
this note and those disagree, they are right and this is stale — and worth
fixing. Everything here points at real files so you can follow along in the
editor.

Where things stand as of writing:

| Package | Source lines | Tests |
| --- | --- | --- |
| `packages/protocol` | 1,183 | 26 |
| `packages/assistant-core` | 2,882 | 56 |

The protocol defines 6 command types, 18 durable record types, and 16 live event
types. Nothing has yet run end to end against a real model with real tools.

---

## Part 1 — Why not just call the API in a loop?

The naive coding agent is about thirty lines:

```js
while (true) {
  const reply = await callModel(messages);
  if (!reply.toolCalls) break;
  for (const call of reply.toolCalls) {
    messages.push(await runTool(call));
  }
}
```

This works for a demo and then fails at every real requirement:

- **The user closes the terminal.** Where was the conversation? It was in a
  local variable.
- **A tool needs permission.** Now the loop must pause mid-iteration and wait
  for a human, while remaining cancellable.
- **The user hits Ctrl-C.** A tool is running. A model request is streaming.
  What is the state of the world?
- **You want a UI as well as a CLI.** The renderer needs the same events, and
  now `messages` is being read by two things.
- **The task is long.** History exceeds the context window and the model starts
  failing, or silently degrading.
- **Something goes wrong in production.** You want to know exactly what the
  model saw and what the tools did. `messages` is gone.

Every one of these is a *state and boundary* problem, not a model problem. So
the architecture is mostly about state and boundaries, and the loop itself is
almost an afterthought.

---

## Part 2 — The one idea that shapes everything

Three kinds of data, never confused:

```text
CommandEnvelope   what someone ASKED for      (input, may be rejected)
DurableRecord     what actually HAPPENED      (persisted, ordered, permanent)
LiveEvent         what it LOOKS like happening (ephemeral, for humans)
```

Read `packages/protocol/src/index.ts` with those three words in mind and the
whole file falls into place.

Why this split is load-bearing:

**Commands can be refused.** "Cancel this turn" is a request. If the turn already
finished, the answer is no. A design where cancel is a method call has nowhere to
put that no.

**Durable records are the truth.** They are append-only, each gets a `sequence`
assigned by the writer, and state is *derived* from them by replay rather than
stored separately. Rebuild the world at any point by folding records. This is why
resume is possible at all.

**Live events are disposable.** `content.delta` — one token of streaming text —
is a live event with no durable counterpart. The durable version is a single
`assistant.message.completed` carrying the whole string. **Replay reconstructs
the message, not the typing.** Reconnect halfway through and you get the finished
paragraph, not the keystrokes. That is a deliberate asymmetry and it is why the
live path can be lossy without being dangerous.

The consequence worth internalising: **anything terminal is written before it is
announced.** Persist, then publish. A renderer must never learn a fact that is
not yet durable, because then a crash makes the UI and the log disagree about
reality.

### Derived state, not stored state

Two functions do the deriving:

- `reduceEngineState(records)` — the machine's view: which turns are running,
  which tools are awaiting approval.
- `reduceProviderHistory(records)` — the *model's* view: the messages it is
  allowed to see.

Two different projections of the same log. That separation matters: the model
must not see approval bookkeeping, and the engine must not confuse "what the
model knows" with "what happened".

`reduceEngineState` also **validates**. It returns an `issues` array, and it
flags duplicate entities, missing parents, illegal transitions, and sequence
gaps. This gives you the project's single most useful invariant:

```js
reduceEngineState(records).issues  // must always be empty
```

If that array is non-empty, the engine emitted a record sequence the protocol
considers impossible. Every test that produces records asserts this. When a doc
and the reducer disagree, **the reducer wins** — it is executable and the doc is
prose.

---

## Part 3 — The anatomy of one turn

Happy path, one tool call, from `design.md`:

```text
conversation.created
session.created
turn.started                    <- user asked something
user.input.accepted
provider.step.started           <- step 1: ask the model
assistant.message.completed     <- "I'll look at that file."
tool.requested                  <- one per call, in providerOrder
provider.step.completed           stopReason "tool-use"
  [ approval.requested ]        <- only if policy said ask
  [ approval.resolved   ]       <- human answered
tool.result.completed           <- the file contents
provider.step.started           <- step 2: model now sees the result
assistant.message.completed
provider.step.completed           stopReason "complete"
turn.completed
```

A **turn** is one user request. A **step** is one round-trip to the model. A turn
with tools has several steps. That distinction is why the vocabulary has both.

Three subtleties in that sequence:

1. **Policy runs before `tool.requested`, not after.** The record carries a
   `requiresApproval` field that the reducer reads to set the tool's initial
   state, so the decision must already exist when the record is written. This
   isn't a preference — writing the record first makes the sequence illegal.
2. **Requests are written lazily, one tool at a time.** If tool 1 aborts the
   turn, tools 2 and 3 never get a `tool.requested` at all. Nothing to terminate,
   so the "every request reaches exactly one result" invariant holds trivially
   instead of needing synthetic cleanup records.
3. **The model's view is session-scoped.** Provider history comes from the
   current session's records, never the whole store. Get this wrong and one
   project's conversation leaks into another's — which happened, see Part 8.

---

## Part 4 — The seams

The engine talks to the world through seven injected ports
(`packages/assistant-core/src/ports.ts`):

```text
ProviderPort      talk to a model
ToolExecutorPort  run a tool
ToolPolicyPort    allow / deny / ask, before running anything
DurableSink       persist records, assign sequence
LiveSink          publish ephemeral events
EngineIds         generate ids        <- injected so tests are deterministic
EngineClock       current time        <- same reason
```

The last two look like over-engineering and are not. If the engine calls
`Date.now()` and `randomUUID()` directly, no test can assert on an exact record
sequence, because every run produces different ids and timestamps. Injecting them
is what makes "assert the precise sequence of 11 records" a realistic test.

The engine holds **no renderer callbacks, no shared memory with clients, and
passes no object references across a boundary.** Everything crossing a boundary
must survive `serializeJson`, which is far stricter than `JSON.stringify` — it
rejects `undefined`, `Date`, class instances, `Map`, `Set`, and anything whose
prototype isn't plain. That strictness is deliberate: it makes a value that
could never cross a network fail immediately, in the fastest test, rather than
the day you add a real transport.

### Two failure vocabularies

This is the distinction I would most want you to carry away.

| Kind | Example | Becomes | Consequence |
| --- | --- | --- | --- |
| **Recoverable** | file not found, command exited 1 | `tool.result.failed` | model sees it, tries again |
| **Fatal** | provider protocol violation, broken executor | step or turn failure | work stops |

So a tool returns `{ kind: "failed", error }` rather than throwing. A *throw*
from a tool means the executor itself is broken. And a non-zero shell exit is a
**success** — the model needs to read that compiler error.

Get this boundary wrong and the agent becomes brittle in a specific, maddening
way: a typo in a tool argument kills the whole turn instead of the model simply
correcting itself.

---

## Part 5 — Where the model meets the wire

Live in `packages/assistant-core/src/providers/openai-chat-completions/`.

The adapter's job: turn one provider's streaming bytes into canonical
`ProviderEvent`s, and let nothing provider-shaped escape. No SSE, no provider
event names, no provider finish-reason strings. The engine must not be able to
tell which provider it is talking to.

Six files, each answering one question:

```text
http.ts        how do we reach it, and what does failure mean?
request.ts     what do we send?
history.ts     how does our record log become their message format?
frames.ts      what is one chunk of their stream, safely typed?
translate.ts   what sequence of our events does their stream mean?
tool-calls.ts  how do fragments of a tool call become one call?
adapter.ts     wire the above together
```

Two ideas worth understanding properly:

**Tool calls arrive in fragments.** The model streams arguments as partial JSON:
`{"pa`, `th": "src/`, `main.ts"}`. The assembler accumulates and only emits
`tool-call-complete` once the buffer **parses**. If the stream dies mid-arguments,
that is a truncated call and must never reach the engine as a parse exception.
This is the single behaviour a naive adapter gets wrong.

**Wire validation and input validation are different jobs.** The adapter checks
*well-formedness*: are the arguments parseable, does the finish reason agree with
what was streamed. Failing that is a `protocol` error and kills the step. Whether
the arguments match the tool's declared schema is the **tool layer's** job, and
failing that is recoverable. Put schema checking in the adapter and you have
converted a retryable mistake into a dead turn.

Gemini draws the same line: its stream translator contains zero references to
`validate` or `schema`, and validation lives in `tool.build(args)` called from
the scheduler.

---

## Part 6 — Tools

The target shape, borrowed from gemini-cli, is two-phase:

1. **The tool** owns its name, description, parameter schema, and whether it
   mutates. It validates raw input.
2. **The invocation** holds validated, typed parameters, knows how to describe
   itself for an approval prompt, and runs.

The schema is a zod object, and two things are derived from it: the JSON Schema
sent to the model via `z.toJSONSchema()`, and the TypeScript parameter type via
`z.infer`. One definition, so a handler cannot disagree with its own schema.

**Field descriptions are prompt surface, not documentation.** They are how the
model learns to call the tool correctly. Write and review them like prompt text.

Six tools in v1: `read`, `write`, `edit`, `glob`, `grep`, `shell`. Worth knowing
that codex ships **no** grep or glob tool at all and routes search through the
shell; we went the other way because structured results beat parsing shell
output, and each tool can be policy-gated individually.

One thing to be clear-eyed about: **`shell` is not confined.** Path confinement
protects the file tools; a shell command can `cd /` and read anything. That is
precisely why it asks for approval every time until the sandbox arrives in
Milestone 4. Policy is not containment.

---

## Part 7 — The invariants

Short list, but they are what makes the thing trustworthy.

1. **`reduceEngineState(records).issues` is always empty.**
2. **Every `tool.requested` reaches exactly one terminal result** — completed,
   failed, denied, or aborted. No exceptions, including cancellation. A model
   that sees a request with no result is looking at a malformed conversation and
   the provider will reject it.
3. **Durable before live**, for anything terminal.
4. **First terminal write wins.** Once a tool call has a terminal record,
   later writes are dropped. This is how a cancel racing a completion resolves
   without a coin flip.
5. **Appends are serialized**, one ordered writer per log, because the reducer
   requires `sequence === lastSequence + 1`. But *commands* run concurrently —
   serializing whole commands would deadlock, since `turn.submit` doesn't finish
   until the turn ends, which needs the approval command waiting behind it.
6. **Resume by durable sequence, never by live-event id.** `LiveEvent.sequence`
   is typed `never` specifically so you cannot.

---

## Part 8 — Seven scars

The most useful part of this note. Each was a real bug in this codebase.

**1. The 1,320-character line.** An implementation shipped with the line breaks
removed — one line held an entire tool-execution loop. The repo had no formatter
config, so nothing prevented it. *Lesson: a convention nobody enforces isn't a
convention.* Biome landed right after.

**2. Provider history leaked across conversations.** The engine passed its entire
record store to `reduceProviderHistory`, so talking in project A then project B
showed A's conversation to B's model. *Lesson: "which records?" is a real design
question, not a detail. Default scopes are usually wrong.*

**3. The forked reducer.** Fixing #2 by filtering the global store created
sequence gaps, which the protocol reducer flagged as errors — so a 172-line copy
of it was made with that check removed. It works, and there are now two
definitions of model-visible history, one invisible from the protocol package.
*Lesson: when a fix requires duplicating a component, the real problem is
usually one level down.* Here it is that the store is global when the protocol
names a per-session log. Tracked as debt with a deadline.

**4. The capture proxy that buffered.** A recording proxy used
`response.read(1024)`, which blocks until it has 1024 bytes or EOF. Provider
events are smaller than that, so it delivered nothing until the connection
closed — while a smoke test checking "did bytes arrive" passed happily.
*Lesson: for streaming, test timing, not arrival.*

**5. Transport failures weren't classified.** `fetch` wasn't wrapped, so a
network error escaped as a raw `TypeError`, losing `retryable`. The engine caught
it and degraded gracefully, so nothing looked broken — retries just silently
never happened. *Lesson: graceful degradation hides bugs. Check what you lost,
not just that you survived.*

**6. The model was never told the tools existed.** `ToolDefinition` and the
`tools` field were dropped during a refactor. So no real provider could ever emit
a tool call — the tool half of the loop was reachable only from the test double,
which fabricates calls directly. Forty passing tool tests were fully compatible
with tool calling being impossible in production. *Lesson: a test double that
supplies its own inputs can validate everything except whether the real input
ever arrives.*

**7. Multi-tool history was malformed.** Each tool request became its own
assistant message; OpenAI needs one assistant message carrying all the calls.
Invisible until two tools ran in one step — which could not happen, because of
#6. *Lesson: bugs hide behind other bugs, and the order you fix them changes
what you can see.*

The common thread: **five of the seven were invisible to a green test suite, and
four were found by trying to run the thing end to end.** Integration is not a
final checkbox; it is a different instrument.

---

## Part 9 — Reading order

If you want to actually know the codebase, read in this order:

1. `packages/protocol/src/index.ts` — the vocabulary. Everything else assumes it.
2. `packages/protocol/src/engine-state.ts` — `reduceEngineState`. The rules about
   what sequences are legal live here, in code.
3. `packages/protocol/test/*.test.mjs` — the closest thing to executable
   documentation in the repo.
4. `packages/assistant-core/src/ports.ts` — the seams, in one screen.
5. `packages/assistant-core/src/turn-runner.ts` and `tool-wave-runner.ts` — the
   actual loop.
6. `packages/assistant-core/src/providers/openai-chat-completions/translate.ts` —
   how a stream becomes events.
7. `design.md`, Decisions 1–12 — the why, once you have seen the what.

---

## Part 10 — What is not true yet

Being honest about this matters more than the architecture diagram.

- **Nothing has run end to end against a real model with real tools.** The
  adapter was proven alone against a live gateway; the loop alone against the
  test double; the tools alone against temp directories.
- **Tool definitions still don't reach the model.** Scar #6 is diagnosed, not
  fixed. That is the next piece of work.
- **No persistence.** The only `DurableSink` is in-memory and lives in
  `testing.ts`. Records are produced correctly and then dropped on exit, so there
  is no resume yet.
- **No transport, no CLI.** The renderer boundary is designed and unbuilt.
- **No compaction.** A long task will exceed the context window and fail.
- **No sandbox.** `shell` is approval-gated and otherwise unconstrained.

Roughly: the skeleton and nervous system exist and are unusually well tested. The
muscles are partly attached. It has never stood up.

---

## Things to try yourself

Best way to make this stick:

1. Open `engine-state.ts` and find where it rejects a second terminal record for
   the same tool call. That one check is invariant #4.
2. Find why `LiveEvent.sequence` is typed `never`, then try to use it for resume
   and watch the compiler stop you.
3. Run `node scripts/e2e-turn.mjs "hello" --workspace .` with
   `TURNTURN_BASE_URL=http://127.0.0.1:1`. It fails — read the 6 records it
   produced and confirm `issues` is empty. A clean failure is a designed
   behaviour, not an accident.
4. Trace one `content.delta` from the provider stream to stdout and count the
   boundaries it crosses. Then ask why it never becomes a durable record.
5. Open `tool-calls.ts` and work out what happens if a provider never sends a
   tool-call id. (It is a live bug as of writing. Knowing why is the test of
   whether Part 5 landed.)
