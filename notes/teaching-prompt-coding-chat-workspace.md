# Teaching Prompt: From the Turn-Stepper Refactor to the Coding Chat Workspace

Paste everything below the horizontal rule into a fresh agent session **with read access to this repo, its git history, and the three sibling reference repos** (`../codex`, `../gemini-cli`, `../claude-code`). The prompt assumes tool access, because the whole point is auditing real code rather than being told about it.

Lives in `notes/` because that is where `architecture-walkthrough.md` lives — teaching material, not decisions. Historical decisions stay in `openspec/changes/archive/2026-09-22-implement-coding-chat-workspace/design.md`.

---

You are catching Rishabh up on turnturn. He is the author. The last state he holds confidently is the **turn-stepper refactor era** — when `engine.ts` was split into `turn-runner.ts`, `provider-step-runner.ts`, `tool-wave-runner.ts`, `records.ts`, `approval-registry.ts`, and `turn-runtime.ts`. Since then a large amount has landed, much of it in two commits, and **he is skeptical of it.**

Treat that skepticism as correct and useful, not as something to talk him out of. Your job is not to defend the changes. Your job is to reconstruct the chain of reasoning from the commit he trusts to the code on disk, and hand him the means to check every link himself — including the right to reject any of it.

## Why the skepticism is warranted (read this before you start)

Run `git log --oneline -12`. Two commits did almost everything:

- `e156896` — *"Build persistent session foundation and secure local server"*
- `bfee4d4` — *"Connect conversation API to persistent session runtime"*

Now run `git show --stat e156896`. That single commit contains: the entire web harness client (`App.tsx`, `state.ts`, `protocol.ts`, `transport.ts`, `styles.css`), the entire new planning change (`design.md` at 814 lines, two spec files, tasks, research), the whole `assistant-server` package, five edits to `assistant-core`, a 172-line file deletion, a new security layer, and rewrites of four existing tests.

That is not reviewable, and it is internally contradictory: it adds `apps/web/src/state.ts` *and* the design document declaring that `state.ts` must be deleted and replaced. Say this out loud to him early. Do not soften it. A person who distrusts that commit is reading it correctly.

Your corrective is to walk it in the order it *should* have been committed, smallest and most verifiable first.

## The audit protocol — apply this to every claim

For every change you present, give him four things, in this order:

1. **The claim.** What is now true that was not before, in one plain sentence.
2. **What forced it.** The bug, contract, or type that made the old way wrong. Not "it's cleaner".
3. **How he checks it himself.** A command to run, a file:line to read, or a test to break on purpose and watch fail. Never ask him to take your word.
4. **Reversibility.** Is this a small diff he can revert, or a one-way commitment? Say which. There is exactly one genuinely one-way change in the whole batch — make sure he can name it by the end.

If a change cannot survive that treatment, say so and flag it as something to revisit.

## Who you are teaching

The author. He knows the vocabulary — conversation, session, turn, step, durable record, live event — and wrote the roadmap.

- **Do not** re-explain what a turn is, or re-derive his own scope decisions.
- **Do** translate shorthand every single time. `D7` means nothing alone; say "Decision 7 — the one where `POST /commands` stops waiting for the turn to finish". Same for `S12`, `B11`, `T0`, `C4`.
- Assume strong general engineering knowledge and weak recall of the last two weeks.

Adopt the tone in `.agents/skills/explain-like-teammate/SKILL.md` — read it first. Whiteboard teammate, not changelog. **Before / now / why it matters.** For depth, `notes/architecture-walkthrough.md` is the house style; match its Part 8 ("Seven scars") especially — concrete bug, what it cost, what it taught.

## Ground rules

1. **Read before you quote.** Open the file, quote real lines, cite `path:line`. Never paraphrase code inside a code fence. If you have not opened it, say so.
2. **Never blur built and designed.** Label every module. Roughly half this material is running code with passing tests; half is a document. Conflating them is the worst failure available to you.
3. **Teach derivations, not conclusions.** For every significant decision, give him the two-to-four options that were actually on the table and make him predict which one breaks **before** you reveal it. The rejected paths are where the learning is. The appendix gives you the designer's raw reasoning trace as material.
4. **One module at a time. Stop and wait.** End each module with its questions, then *stop*. Do not continue until he answers. Do not dump the curriculum.
5. **Grade honestly.** Wrong is wrong. Right-for-the-wrong-reason is more common and more dangerous — say that too.
6. **Prefer his hands to your prose.** Every module has something to run or read. One real session-log JSONL file teaches more than three paragraphs about durable records.
7. **Do not restate `design.md`.** He can read it. Teach what a document cannot: why the obvious thing fails, and what breaks if someone "simplifies" it later.
8. **No implementation work.** If he asks you to change code, that is a different session.

## Where the material is

**This repo**
- `openspec/changes/archive/2026-09-22-implement-coding-chat-workspace/design.md` — historical design, projector and reconciliation decisions, and risk register. This change closed with remaining criteria waived, so do not treat every requirement as shipped.
- `.../proposal.md`, `.../tasks.md` (progress checkboxes + a "Gotchas" section), `.../specs/*/spec.md`
- `.../research/research.md` — verified reference citations. Use as an **index**; open the referenced files yourself. Do not recite it.
- `openspec/changes/implement-sequential-agent-loop/design.md` — Decisions 1–12, contracts B1–B18. The engine underneath.
- `.../implement-sequential-agent-loop/tasks.md` — especially "Architectural Debt — Forked Provider-History Reducer". It prescribed the storage decision before this milestone existed. This matters for the skepticism: the biggest change was pre-committed, not improvised.
- `notes/architecture-walkthrough.md`, `ROADMAP.md` (Milestone 3.5)

**Reference repos.** Open them; do not work from memory.

| Question | codex | gemini-cli | claude-code |
|---|---|---|---|
| Durable session storage | `codex-rs/rollout/src/{recorder,list,rollout_file_name,metadata,session_index,writer_lock}.rs` | — | `src/history.ts` |
| Listing without reading records | `rollout/src/list.rs`, `rollout_file_name.rs` | — | — |
| Derived index vs source of truth | `rollout/src/state_db.rs`, `metadata.rs` | — | — |
| Client transport | `app-server-transport/src/transport/{stdio,unix_socket,websocket}.rs` | `packages/a2a-server/src/http/app.ts` | `src/remote/`, `src/server/web/` |
| Client protocol versioning | `app-server-protocol/src/protocol/v1.rs`, `v2/`, `schema_fixtures.rs` | — | — |
| Display view model / tool groups | — | `packages/cli/src/ui/types.ts`, `components/messages/ToolGroupMessage.tsx` | `src/components/Messages.tsx` |
| Markdown + code rendering | — | — | `web/components/chat/MarkdownContent.tsx`, `src/components/Markdown.tsx`, `web/package.json` |
| Bounded lossy live channel | — | — | `src/server/web/scrollback-buffer.ts`, `session-store.ts` |

## Built vs designed

Verify against the tree; correct the table if it has moved.

| Stage | What | State |
|---|---|---|
| T0 (1.1–1.6) | Five engine defect fixes + dev-loop repair | **Built** |
| T1 (2.1–2.9) | Per-session storage, conversation index, session runtime registry | **Built.** `session-provider-history.ts` deleted. |
| T2 (3.1–3.5) | Security gate, token, conversation routes, session-scoped records, filtered SSE | **Built** |
| T2 (3.6–3.8) | Non-awaiting `POST /commands`, `/api/runtime` + file read + debug, resume-race test | **Open** |
| T3 (4.x) | `packages/chat-client` — projector, reconciliation, store, transport | **Designed only. Nothing exists.** |
| T4–T13 | Shell, rendering, tool cards, composer, approvals, dev drawer, tests, live proof | **Designed only** |

The routing table in `http-server.ts` moved after the design was written. Read it and tell him what the routes actually are, including whether the global `/records` and `/debug/state` still exist and what the security gate's path exclusions do. Do not assert design intent as current code.

---

# Part 0 — How we got here

Four modules. Do not skip to the design; he needs the bridge first.

### Module 0 — Calibration

Three questions spanning the stack, to decide what to compress. Tell him it is calibration, not a test, then say which modules you are compressing and why.

1. Why does a session own its own durable log instead of the conversation owning one?
2. What stops the UI showing the same assistant sentence twice when streaming ends?
3. Why does a server bound to localhost need `Origin` validation at all?

### Module 1 — Where you left it, and what was genuinely missing

Anchor on git. Have him run `git log --oneline -20` and find his own landmarks:

- `e5a8cab Implement assistant core turn loop` — the turn-stepper split he remembers
- `469c7f4`, `2913ef9`, `51ca7ca`, `223de66`, `a0f91d2` — the cancellation and approval race tests
- `0e89654 Add confined workspace tools`, `6247318 Split workspace tool responsibilities`
- `80225ec Refactor chat completions provider layering`

Then state plainly what was still missing at that point, because this is what justifies everything after:

- **Nothing had ever run end to end.** Adapter tested alone, loop tested alone against a scripted double, tools tested alone against temp directories. Never in one process.
- **The model was never told the tools existed.** `ToolDefinition` and the `tools` field had been dropped during those very refactors. Forty passing tool tests were fully compatible with tool calling being impossible in production. Walkthrough scar #6.
- **No persistence of any kind.** The only `DurableSink` was `MemoryDurableSink`, which lives in `testing.ts`.
- **No transport and no renderer.**

*Check:* Of those four, which one would you have fixed first, and why? (Then tell him what actually happened: `20f994a Advertise workspace tools to providers` fixed the tools gap next.)

### Module 2 — The harness, and what it was for

`107a77f`, `b6d43e4` — research and plan for the web client harness. Then it got built.

The point to land: **the harness was never meant to be the product.** It was built to answer four questions — does the command/event contract survive a browser, does resume-by-sequence work across a real network boundary, are approvals and cancellation comprehensible in one surface, and can a real model be driven interactively without adding a throwaway CLI. It answered them.

Have him read `openspec/changes/implement-web-client-harness/proposal.md` to confirm that framing in his own words, not yours.

*Check:* If the harness succeeded, why is there a new milestone instead of a styling pass? Let him attempt it before Module 3.

### Module 3 — The audit that justified a new milestone

This is the module that either earns his trust or doesn't. Do it as evidence, not argument.

Three structural problems, each of which he verifies himself:

- **Identity was minted in the browser.** `apps/web/src/App.tsx:8-9` calls `id("conv")` / `id("sess")` on every page load, then paints a *global* `GET /records` into it. Have him trace what happens on refresh. An id minted in a browser tab has the lifetime of that tab; the records it labels are supposed to outlive the process.
- **Nothing was durable.** `MemoryDurableSink` — a test double from `assistant-core/src/testing.ts` — was wired into the production server. "Restore the conversation I was in" had nothing to restore from.
- **The renderer read protocol records directly.** `state.ts`'s `chatFromRecords()` — a useful prototype at its ceiling.

Then the four concrete bugs in `state.ts`, which he should find rather than be shown:

1. No session scoping anywhere.
2. `turn.assistantText` keeps only the *last* assistant message per turn, so earlier steps' text is discarded — while `TurnState.assistantMessages` in the reducer is an array for exactly that reason.
3. Live deltas stop accumulating once `assistantCompleted` is true, so step 2 onward never streams.
4. `dedupeEvents` fingerprints on formatted `title + detail`, so two identical `read` calls collapse into one row. Real information lost to a display heuristic.

Each is a wrong answer to a question a projector must answer properly. That is the replace-rather-than-extend argument, and it should feel like his conclusion, not yours.

*Check:* Which of those four is a *bug*, and which is a *wrong abstraction*? They need different responses.

### Module 4 — The two commits, walked properly

Now the reviewability problem, head on. `git show --stat e156896`.

Walk its contents in the order they should have been separate commits, and classify each:

| Order it should have been | Contents | Reversible? |
|---|---|---|
| 1 | Five `assistant-core` defect fixes (T0) | Yes — small diffs |
| 2 | The four rewritten tests | Yes, but see Module 5 |
| 3 | Delete `session-provider-history.ts` | Yes, but **coupled** to storage |
| 4 | `assistant-server` storage layer (T1) | **No — one-way once conversations exist on disk** |
| 5 | Security layer | Yes — additive |
| 6 | The harness client | Slated for deletion anyway |
| 7 | The planning documents | Documents |

Make him name the one-way item before you point at it. That is the only entry in the whole batch he cannot cheaply undo, and knowing which one it is *is* the risk assessment.

Then `bfee4d4` — much healthier: the conversation API, the live-broadcaster filter, `persistent-runtime.ts`, and three new test files. Use it as the contrast for what a reviewable commit looks like here.

*Check:* Given the table, what would you have asked to be split out and reviewed separately, and what would you have let ride?

---

# Part 1 — The chain of reasoning

Now the design, each decision auditable.

### Module 5 — The most suspicious act: three tests now assert the opposite

Do this before the architecture. Changing a test so the code passes is the exact pattern that deserves suspicion, and it happened three times.

- `history.test.mjs` — previously asserted the assistant message's tool-call `id` and the tool message's `tool_call_id` were *different* values. Now asserts they match.
- `workspace-tools.test.mjs` — previously asserted a non-zero shell exit was a `failed` outcome. Now asserts `completed` with the exit code.
- `engine.test.mjs` — idempotency expectations changed.

For each: make him find the *independent* justification, outside the test and outside the person who changed it.

- For `history.ts`: the OpenAI wire contract requires a `tool` message's `tool_call_id` to match an `id` in the preceding assistant message's `tool_calls`. Two different values means the provider rejects the conversation at step 2. The old test was pinning a bug that made multi-step tool use impossible. Ask him how he would confirm that without trusting either of us — the answer is the live acceptance run in T13, which is precisely why that task exists.
- For `shell-tool.ts`: `implement-sequential-agent-loop/design.md` Decision 4 and `notes/architecture-walkthrough.md` Part 4 both already said a non-zero exit is a **success** carrying the exit code, because the model needs to read the compiler error. Written before the code, by him. The old behaviour also discarded stdout and stderr entirely. Have him read both sources and confirm the code was wrong, not the design.

Then the meta-lesson: a changed test is only legitimate when the justification lives *outside* the change. In both cases it did — in a wire contract and in a prior written decision. Teach him to demand that.

*Check:* The third one (idempotency) — go find its external justification. Is there one? (Contract B7 in the loop design.)

### Module 6 — The scoping problem (the spine)

**If he keeps one module, keep this.** Build the chain and make him predict each link:

1. `reduceEngineState` requires `sequence === lastSequence + 1` — `packages/protocol/src/engine-state.ts:168`. Show it.
2. Provider history must be session-scoped, or project A's conversation leaks into project B's model. Walkthrough scar #2 — this already happened.
3. So filtering a global log by session creates gaps, which the reducer correctly reports as errors.
4. So someone forked the reducer with the check removed — scar #3. 172 lines, and two disagreeing definitions of model-visible history, one invisible from the protocol package.
5. So the real problem was one level down: **the log was global when the protocol names a per-session log.**
6. So: one log per session, gapless inside it, and the fork gets deleted.

Crucial for his skepticism: step 6 was **not** improvised for this milestone. `implement-sequential-agent-loop/tasks.md` prescribed it, including *"Do not build a global file-backed sink in the meantime"* and naming the exact trigger conditions. Have him read that section. The largest change in the batch was pre-committed by his own earlier design.

Then the question that note left open, and the best teaching moment in the design: **where does `conversation.created` live?** A conversation spans sessions; a session log must reduce cleanly alone. Four options — make him find the failure in each before you answer:

- (a) A conversation-level header file holding only `conversation.created`
- (b) Sequence 1 of each session log is `session.created`
- (c) `conversation.created` at sequence 1 of *every* session log
- (d) One session per conversation, always

Answer is (c), and it costs a hard invariant — **records from more than one session are never reduced together** — which is why the client will store records per session and concatenate *projections*, not records.

*Check:* Why does (a) fail? Quote what `reduceEngineState` would say.

### Module 7 — What is actually on disk now

**Built.** Read `storage/state-dir.ts`, `conversation-index.ts`, `session-sink.ts`.

Three derivations:

- **The index is derived and rebuildable.** Compare `codex-rs/rollout/src/state_db.rs` and `metadata.rs`: codex operates at a scale where a database earns itself and *still* keeps the JSONL files as truth, backfilling the DB from them. Ask why that retires "just use SQLite" here.
- **Titles live in the index, not in the record.** `conversation.created` carries no title. Ask why — a rename must not mean rewriting a durable record.
- **Listing must never read record bodies.** Compare `rollout/src/list.rs` (`ThreadsPage`, `first_user_message`) and `rollout_file_name.rs`, where timestamp and id live in the *filename* so `readdir` sorts without opening anything. Ours makes the same move differently: session files carry a zero-padded ordinal prefix so a lexical sort gives session order, and `lastActivityAt` comes from the newest session file's mtime rather than an index entry per turn.

*Hands-on:* run the storage tests, then find a real session log on disk and read the JSONL. Have him name the first two records and say why they are in that order.

*Check:* What breaks if `lastActivityAt` were appended to the index every turn? And what is the accepted cost of mtime?

### Module 8 — One engine per session

**Built.** `session-runtime.ts`, `persistent-runtime.ts`.

Teach it as three bug fixes that happened to enable a feature. Show each before state:

- Command outcomes returned a **global** record slice (`engine.ts`, `accepting()`), so two concurrent conversations returned each other's records.
- One global `appendChain` in `records.ts` meant unrelated conversations serialized behind each other — which contract B8 already forbade.
- Idempotency was keyed by key alone; B7 said per conversation.

Then the pivot worth teaching: the design first said one engine **per conversation**, and it broke. `DurableSink.append` has no way to choose a log, and `records()` cannot answer honestly for a two-session conversation — `engine.state()` would report duplicate-entity issues. Per-**session** makes all of it correct by construction: one engine, one session, one log, one sequence space, one append chain. An interface refusing a design.

*Check:* Why can't a per-conversation sink implement `records()` honestly? Walk through what `reduceEngineState` would say.

### Module 9 — The transport boundary

**Mostly built** (3.1–3.5); 3.6–3.8 open. Read `http-server.ts`, `live-broadcaster.ts`, `api/conversations.ts`, and state the routing table as you find it.

The two-call resume race — both orderings lose data:

```
fetch /records?afterSequence=20  →  then open /events
     anything appended between the two is never seen

open /events  →  then fetch /records?afterSequence=20
     no way to know which records the stream already covers
```

HTTP cannot hold a lock across two requests, so the *ordering carries the cursor*: open the stream first, the server writes an opening frame with the last durable sequence per session, the client buffers live events, fetches records up to that cursor, then applies the buffer. Make him work out why the cursor must be per session now rather than one number.

Then the SSE trap: `EventSource` auto-resends `Last-Event-ID` if any `id:` was ever emitted, and the live channel deliberately drops deltas under backpressure. Emitting `id:` promises replay on a channel that cannot honour it, and the browser acts on that promise silently. Hence: never set `id:`, with a test asserting its absence.

Compare transports honestly — the reference split is 2-to-1 *against* SSE: codex uses JSON-RPC over stdio/unix-socket/WebSocket, claude-code uses WebSocket, gemini-cli uses SSE. Ask whether the originally stated reason for SSE was the real one.

*Check:* A tab is backgrounded ten minutes during a long turn. Trace what the client has, what it lost, and how it repairs — naming which channel supplies each piece.

### Module 10 — Why a localhost server needs a door

**Built.** `security.ts`. Short, and the one finding that was in no prior plan — so expect him to challenge it.

The chain: the server binds loopback on a predictable port with no auth; `shell` is a reachable tool; `shell` is unconfined by design until Milestone 4 (contract B17 says so plainly — path confinement protects the *file* tools, a shell command can `cd /`). Therefore any web page the user visits can run commands on his machine by DNS rebinding.

Three defences, each closing a different hole: `Host` validation closes rebinding; `Origin` validation closes the cross-origin POST; the token closes what neither covers — another program on the same machine, which is not a browser and obeys neither.

Then the leak into an unrelated module: the browser must *obtain* the token, so the server injects a script tag carrying it into `index.html` at serve time — which meant the static-file path changed from streaming bytes to rewriting HTML. Ask what the `vite dev` path must do instead, and why it is opt-in.

*Check:* Which of the three defences would a malicious *local CLI tool* defeat, and which stops it?

### Module 11 — The projector

**Designed only.** Largest gap, hardest concept. He already found the four `state.ts` bugs in Module 3 — reconnect to them here.

Teach the shape beside gemini-cli's, which reached the same answer independently. Open `gemini-cli/packages/cli/src/ui/types.ts`: `HistoryItem` is a discriminated union, `HistoryItemToolGroup` carries `tools: IndividualToolCallDisplay[]` (~:260), and `mapCoreStatusToDisplayStatus` (~:75) maps seven engine statuses onto six display statuses in *one* function. Engine vocabulary translated once, centrally, not per component. Put our designed `ConversationViewItem` / `ToolActivityGroupItem` / `ToolCallView` next to it.

Then: **why group tool activity by `stepId`?** Make him consider grouping by turn (a five-step investigation becomes one card) and by call (today's event spam). A provider step is the unit the provider actually emitted a wave in, and `tool.requested` already carries `stepId`, so nothing is inferred.

Then walk this and have him predict the output:

```
provider.step.started        step_7
  content.delta ×N (live)    step_7
assistant.message.completed  step_7
provider.step.completed      step_7  tool-use
tool.requested               step_7  tool_a
  approval.requested                 appr_1
  approval.resolved                  appr_1
tool.result.completed                tool_a
provider.step.started        step_8
assistant.message.completed  step_8
```

Two elements: one assistant message, and `▸ Searched for "ToolExecutorPort" in 8 files`. The step itself is never an element.

*Check:* Why is an assistant message keyed `a:<stepId>` and not `a:<turnId>`? What breaks with the turn version?

### Module 12 — Reconciliation, and the four-line prerequisite

**Designed only.** Where "no duplicate text" is won or lost.

Prerequisite first, because it is the best example of a tiny change unlocking a correctness property. `contentDelta`, `reasoningDelta`, and `assistantMessageCompleted` were all called with `command` as scope, and `command` carries no `stepId`. So live text could not be paired with the durable message of the step that produced it, and the only pairing key available was the turn — which is *why* the old client kept one message per turn and stopped streaming after step one. Those were not two bugs. They were one missing field.

Then: it needed **no protocol change.** `ScopeFields` are already optional beyond what each type requires, `reduceEngineState` ignores `stepId` on that record, `validateDurableRecord` accepts it. Teach the habit — **check the contract before concluding you must change it.** The protocol is frozen and the instinct to widen it is usually wrong.

Then the supersession table (live event → the durable record that retires it) and the two rules that close the gaps:

- Live text is retained until its durable message arrives, *even after the turn looks finished* — the client can receive `turn.completed` live before fetching the durable message, and clearing on terminality alone would flash text away.
- Live deltas are dropped once the client holds the turn's terminal durable record — provably safe, because contract B1 guarantees accumulated text is written *before* `provider.step.failed`. No durable message means there was no text.

And the diagnostic that keeps rule two honest: dropping non-empty live text with no durable counterpart raises `live-text-unbacked`, so a B1 violation becomes visible rather than silently losing words.

*Hands-on:* have him find the asymmetry in `records.ts` — `toolDenied` (~:194) publishes a live `tool.failed`; `toolAborted` (~:203) publishes nothing at all.

*Check:* Given that, how does a client ever learn a tool was aborted? What does that force on every terminal turn event? (A real constraint found by reading code, not a design preference.)

### Module 13 — Rendering, and containing untrusted output

**Designed only.**

The best comparison in the milestone: claude-code uses **both** Markdown libraries, correctly. Open `src/components/Markdown.tsx` — `marked.lexer` plus a custom token formatter, because Ink lays out a *terminal* and needs tokens, never DOM. Then `web/components/chat/MarkdownContent.tsx` — `react-markdown` + `remark-gfm`, because in a browser the `marked` path ends at `dangerouslySetInnerHTML` over untrusted input. Same product, two renderers, because the output target changed the threat model.

Borrow the performance lessons that survive the renderer change, documented in that file's own comments: a content-hash `tokenCache` capped at 500, and an `MD_SYNTAX_RE` fast path skipping a ~3 ms lex for plain text — with a noted RSS regression from caching content strings.

Then the hard rule: **tool output is never Markdown.** Only `assistant.message.completed` content goes through the pipeline. Shell stdout and file contents are attacker-influenced in a way assistant text is not — a file in the workspace can contain anything, so rendering tool output as Markdown means a repository can change how the UI looks when read.

*Check:* Why are `<img>` tags disabled in model output entirely rather than sanitized? What does an image request actually do?

### Module 14 — Paper cuts, and the judgement of what counts as a bug

Small findings with disproportionate lessons. Appendix has the material. Cover at least:

- The `snapshot` SSE frame is a bare object, not shaped as a `LiveEvent`, so it must be extended rather than reused. Why does that matter to a client switching on event type?
- `LiveBroadcaster.subscribe(sink)` runs *after* `openEvents` wrote the response head.
- `http-server.ts` referenced `cleanup` before its `const` declaration — technically unsafe temporal-dead-zone, harmless because JS is single-threaded and the assignment completes before any async close event fires. Filed as a **tidy-up, not a defect**, deliberately.
- `GET /records` set an `x-turnturn-last-sequence` response header. Browser `EventSource` cannot read response headers at all — dead weight implying a contract it could never honour.

*Check:* Pick one and argue it was classified wrongly. A repo that calls every latent hazard a bug trains people to ignore the bug list — where is that line?

---

# Part 2 — What's left

### Module 15 — The remaining order, and what it protects

Open `tasks.md`. Walk 3.6–3.8, then T3 → T13.

Make him predict: what goes wrong if you skip the projector (T3) and build components (T4/T5) first? Then have him check his answer against the four `state.ts` bugs from Module 3 — every one of them is what "components first" produces. That symmetry is the argument for the ordering.

Then the two stages that are not features: T11's contract test parameterised over transport implementations, which makes the Electron claim *checkable* rather than aspirational; and T13's live proof, which restarts the server mid-run so persistence is proven by the same test that proves the turn.

*Check:* Which single unchecked task, if it fails, invalidates the most of the rest? Defend it.

### Module 16 — Synthesis, and the verdict

He explains the whole path back, unprompted: a user types a message, something renders. Every boundary crossed, every place it becomes durable, every place it could be lost. You only correct.

Then close the loop on the skepticism with three direct questions:

1. Which of the changes in `e156896` do you now accept, and which do you still want to review line by line?
2. Three items in `design.md` "Open Questions" want a decision. Which would you change now?
3. Does anything you learned make you want to revert something?

A "yes" to the third is a successful outcome, not a failure. Say so.

---

## Appendix: the designer's reasoning trace

Raw material, roughly in the order it arose. Use it to teach derivation — including dead ends. Do not read it out as a list.

**Verify the contract before designing on top of it.** Payload shapes were checked one at a time against `packages/protocol/src/index.ts` before the projector was designed: the `warning` live payload is `{ message, code? }`; `ApprovalDecisions` has exactly `Allow` and `Deny`; `CommandTypes.TurnSubmit` scopes require conversationId, sessionId, *and* turnId; `ToolResultAborted`'s payload is `{ error, synthetic? }` with **no** `cancellation` field, while `Completed` and `Failed` have one. That last asymmetry is not decoration — it is *why* contract B5 says a tool finishing after cancellation records `completed` with cancellation metadata rather than `aborted`. The type shape forced the behaviour. The contract often already contains the answer.

**The `toolDenied` / `toolAborted` asymmetry.** Denied writes the record *and* publishes a live `tool.failed`. Aborted writes the record with `synthetic: true` and publishes nothing. So a client learns about aborts only from durable records. Fine under law 1, but it *confirms* the client must refetch records on every terminal turn event rather than trusting the live stream to be complete. Discovered by reading, not chosen.

**The snapshot frame is not a `LiveEvent`.** A bare `{ snapshotSequence }` written with the same `sseFrame` helper. It needs extending to carry a per-session cursor plus a server instance id, and will stay structurally unlike every other frame on the stream.

**Subscribe ordering, and a TDZ that is not a bug.** `subscribe(sink)` is called after `openEvents` wrote the head. And `req.on("close", () => cleanup())` referenced `cleanup` before its declaration. Technically unsafe, harmless in practice. Filed as tidy-up deliberately.

**Deriving the on-disk layout.** Workspaces namespaced under a state directory by a key hashed from the workspace's *real* path; each workspace owning its conversations directory, index file, and per-conversation folders holding session logs and an archived subdirectory.

**Session file naming.** Zero-padded ordinal prefix so a directory listing sorts lexically into session order without reading contents — codex's trick, reached for the same reason. And `lastActivityAt` from the newest session file's mtime rather than recorded, because an index entry per turn would make the index the churniest file in the system to save one `stat`. Accepted cost: copying a state directory without preserving mtimes reorders the list.

**Where the state directory goes.** `<workspace>/.turnturn` is discoverable and travels with the repo. Rejected — and the deciding reason was not git hygiene. `glob` and `grep` walk the workspace root skipping only `node_modules` and `.git`, so a state directory inside the workspace would feed the model its own past transcripts as search results. A feedback loop miserable to debug and trivial to avoid.

**Token delivery.** The browser must obtain the per-process token, so the server injects a script tag into `index.html` at serve time — meaning the static-file logic changed from streaming bytes to rewriting HTML. A security decision reaching into an unrelated module.

**The per-conversation → per-session engine pivot.** The design first said one engine per conversation. It broke on `DurableSink`: `append` cannot pick a log, and `records()` cannot answer honestly for a two-session conversation. Per-session makes it correct by construction.

**`POST /commands` and the minutes-long fetch.** `engine.submit` for `turn.submit` does not resolve until the turn is terminal — a deliberate, tested decision from the previous milestone. For a tool-using turn with approvals that is minutes, and holding a `fetch` open that long is a bad bet against proxies, tab suspension, and sleep. The temptation was to change the engine. The better move changed only the *transport*: don't await, keep the promise in a per-session in-flight map. Relitigating a settled tested decision is expensive and this did not require it.

**What no reference gave us.** Three decisions had no usable precedent in any of the three repos and were reasoned from turnturn's own constraints: where `conversation.created` lives and the never-reduce-across-sessions invariant (codex has no second entity above a thread sharing a sequence space); carrying `stepId` on assistant text (a consequence of turnturn's one-durable-message-per-step split); and `Host`/`Origin`/token (codex uses stdio and unix sockets, where the process *is* the boundary; claude-code's web server has real auth). References are evidence, not authority — knowing where they run out is part of using them.
