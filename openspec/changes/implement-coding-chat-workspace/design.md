# Design: Coding Chat Workspace

Milestone 3.5. Motivation is in `proposal.md`; requirements are in `specs/`; scope and exit criteria are in `ROADMAP.md`. This file holds decisions.

Status: **awaiting review.** Per `openspec/project.md`, implementation does not start until Rishabh has reviewed this document. Four questions in "Open Questions" want an answer; question 4 determines whether exact provider-request diagnostics enter this milestone.

**Gate tier: standard, pending Open Question 4.** The implemented change does not alter a public package API. An exact provider-request diagnostic would need an observer in the exported adapter options, which would change this to the full gate; it is not implemented while that choice is unreviewed. See Decisions 22 and 25.

---

## Context

### What exists, audited rather than assumed

Read before implementing: `packages/protocol/src/index.ts`, `engine-state.ts`, `assistant-core/src/ports.ts`, `turn-runner.ts`, `tool-wave-runner.ts`, and `notes/architecture-walkthrough.md`. Verified state as of 2026-09-12 — `pnpm -r typecheck` clean, `pnpm -r test` green at 63 core + 5 server + 26 protocol tests, `@turnturn/web` reporting 0 tests.

The engine is the part to keep. Ports, the sequential turn loop, five policy outcomes, the approval registry's race handling, six confined workspace tools, and the layered chat-completions adapter are all implemented and covered. `reduceEngineState` is executable law and this design defers to it everywhere.

The frozen protocol already contains the two pieces this milestone needs most, unused:

- `JsonlSessionLogWriter` (`protocol/src/session-log.ts:139`) — append-only JSONL, writer-assigned sequence, duplicate-record detection, and `readSessionLog` with `recoveredCorruptTail`. Named for a *session* log, which is exactly the scoping we need.
- `ScopeFields` are optional on every record and event beyond the ones each type requires, so `stepId` can be carried where it is currently dropped without reopening the protocol. Verified against `DurableScopes` in `index.ts:166-171` and the zod schema in `session-log.ts:79-99`.

### Defects this design must route around or fix

Each is a real finding with a location. They shape the decisions, and T0 of `tasks.md` fixes the subset that blocks correctness.

**Server and engine**

| # | Location | Finding |
|---|---|---|
| S1 | `assistant-core/src/engine.ts:91` | `accepting()` returns `durable.records().slice(before)` — a global slice. Two conversations running concurrently return each other's records in their command outcomes. |
| S2 | `assistant-server/src/runtime.ts:41` | `MemoryDurableSink`, a test double from `assistant-core/src/testing.ts`, is the production sink. One process-wide sequence space; nothing survives exit. |
| S3 | `assistant-core/src/records.ts:41` | One `appendChain` per `RecordEmitter`, and one `RecordEmitter` per engine, so every conversation serializes behind every other. B8 says different conversations run fully concurrently. |
| S4 | `assistant-core/src/engine.ts:36` | `completedIdempotency` is keyed by `idempotencyKey` alone and never checks that the replayed command has the same `type`. B7 requires per-conversation keying and a conflict rejection. |
| S5 | `assistant-server/src/http-server.ts:44` | `GET /records` is global. Any client sees every conversation's records. This is the mixing bug, server side. |
| S6 | `assistant-server/src/http-server.ts:93` | The SSE response sets `x-turnturn-last-sequence`. Browser `EventSource` cannot read response headers, so it is dead weight that implies a contract it cannot honour. The real cursor is the `event: snapshot` frame (`live-broadcaster.ts:54`), which is correct. |
| S7 | `assistant-server/src/live-broadcaster.ts:37` | `publish` fans every event to every subscriber with no conversation filter. |
| S8 | `assistant-server/src/runtime.ts:115` | `publicConfig` returns the full provider `baseUrl` to the browser. The key is correctly withheld; the internal gateway hostname need not be sent either. |
| S9 | `assistant-server/src/http-server.ts` | No `Host` validation, no `Origin` validation, no token. `shell` is a reachable tool with no sandbox until Milestone 4, so any page the user visits can drive it by DNS rebinding. This is the most serious finding in the audit. |
| S10 | `assistant-core/src/provider-step-runner.ts:57,60,90` | `contentDelta`, `reasoningDelta`, and `assistantMessageCompleted` are all called with `command` as scope, which carries no `stepId`. Live assistant text therefore cannot be paired with the durable message of the step that produced it — the root cause of C3/C4 below. |
| S11 | `assistant-core/src/workspace/shell-tool.ts` | A non-zero exit returns `failed("SHELL_NON_ZERO_EXIT")` and **discards stdout and stderr**. Design Decision 4 and `notes/architecture-walkthrough.md` both say a non-zero exit is a `completed` outcome carrying the exit code, precisely so the model can read the compiler error. Today neither the model nor the user sees it. |
| S12 | `assistant-core/src/providers/openai-chat-completions/history.ts:36,45` | The assistant message emits `id: providerToolCallId ?? toolCallId` (line 36) while the tool message emits `tool_call_id: toolCallId` (line 45). Now that `providerToolCallId` is always present, the two disagree and the provider rejects the conversation at step 2. `test/providers/openai-chat-completions/history.test.mjs:16-29` asserts the mismatched shape, so the test suite is pinning the bug. **This blocks the live tool-using acceptance proof.** |
| S13 | `protocol/src/session-log.ts:148` | `JsonlSessionLogWriter.open` throws on any issue other than a missing file, so one unclean shutdown makes a conversation permanently unopenable. `readSessionLog` already computes `recoveredCorruptTail`; nothing uses it. The recovery must live in the sink, not in the frozen package. |
| S14 | `assistant-core/src/rejections.ts` | `tool.cancel` is `UNIMPLEMENTED`. The UI must not offer per-tool cancel. |
| S15 | `assistant-core/src/workspace/instructions.ts` | `discoverAgentsMd` and `resolveFileMentions` are exported and tested but called from nothing, and no system prompt is assembled anywhere. The model runs with no instructions. Out of scope here; it caps how good the acceptance transcript can look, so it is a quality risk on T12, not a correctness one. |

**Client**

| # | Location | Finding |
|---|---|---|
| C1 | `apps/web/src/App.tsx:8-9` | The browser mints `conv_`/`sess_` ids per page load, then paints a global `GET /records` into them. Refresh renders the previous conversation under a new identity. |
| C2 | `apps/web/src/App.tsx:47` | The SSE `useEffect` depends on `lastSequence`, so the `EventSource` is torn down and reopened on **every record**. During streaming that is continuous churn, and deltas are lost in the gaps. |
| C3 | `apps/web/src/state.ts:233` | `turn.assistantText` holds only the most recent `assistant.message.completed`. Earlier steps' text is discarded — `TurnState.assistantMessages` is an array in the reducer for exactly this reason. |
| C4 | `apps/web/src/state.ts:194` | Live deltas stop accumulating once `assistantCompleted` is true, so step 2 onward never streams. |
| C5 | `apps/web/src/state.ts:249` | `dedupeEvents` fingerprints on formatted `title + detail`, so two identical `read` calls collapse into one row. Real information is lost to a display heuristic. |
| C6 | `apps/web/src/state.ts:273` | `pendingApprovalFrom` consults only durable `approval.resolved` and ignores turn cancellation, so a cancelled approval stays on screen offering buttons the server will refuse. |
| C7 | `apps/web/src/protocol.ts` | Hand-duplicated `DurableRecord`/`LiveEvent`/`CommandEnvelope` with `payload: Record<string, JsonValue \| undefined>`. Branded ids and payload types are gone, which is why `state.ts` is full of `String(...)` and `typeof` guards. |
| C8 | `apps/web` | No `vite.config.*`, so `fetch("/commands")` under `vite dev` has no proxy to port 8787. The client only works when built and served from `TURNTURN_WEB_DIST`. The dev loop is broken. |
| C9 | `apps/web/package.json` | `"test": "node --test test/*.test.mjs"` with no `test/` directory. It exits 0 with 0 tests, so a green `pnpm -r test` says nothing about the client. |
| C10 | `apps/web/src/App.tsx:124-228` | An "Initialize" button, the protocol timeline, and `JSON.stringify(debug)` are first-class UI. This is the surface the milestone removes. |
| C11 | `apps/web/src/state.ts:81-87` | Live timeline keys are `live:${eventId}:${index}` — index-based, so they reorder on insert. |

### Constraints that are not negotiable here

The ten architectural laws in the brief, plus: `packages/protocol` is frozen; `reduceEngineState(records).issues` must stay empty; the browser must not import `assistant-core`; tests are `node --test` on `.mjs` against built output; `serializeJson` rejects `undefined`, `Date`, class instances, `Map`, and `Set`; ESM with `.js` extensions on relative imports; `exactOptionalPropertyTypes` means omit a key rather than assign `undefined`.

---

## Goals / Non-Goals

**Goals**

- Separate the four concerns that the harness conflates: durable persistence, transport correctness, conversation projection, and visual presentation. Each gets its own module and its own tests, so a bug in one is diagnosable without reading the others.
- Make conversation identity and scoping structurally impossible to get wrong, rather than correct by convention. If a record can only be written to its own session's log, and a command can only reach its own session's engine, then mixing is not a bug you can reintroduce by editing a component.
- Leave a clean Electron path by making the transport an interface with one implementation today, and by putting everything reusable in a package rather than in `apps/web`.
- Pay off the forked-reducer debt as a side effect rather than as separate work.

**Non-Goals at the design level** (scope non-goals are in `proposal.md`)

- No new engine capability. The turn loop, policy outcomes, and approval semantics are used as-is; the four `assistant-core` edits in T0 are defect fixes and one scope-field addition, not redesign.
- No transcript virtualization. See Decision 20.
- No client-side engine rules. The projector describes what the engine recorded; it never decides what should have happened. Where it disagrees with the records it raises a diagnostic and shows what the records say.
- No abstraction over one implementation. There is one workspace, one provider, one transport. The seams are interfaces because Electron is coming; the implementations are single and concrete.

---

## Product Information Architecture

The protocol has six entity levels. The product surfaces three of them and collapses the rest. Getting this mapping explicit is most of the projector design.

| Concept | Definition | Durable identity | In the UI |
|---|---|---|---|
| **Workspace** | An absolute filesystem root the server is configured to operate in. | Not a protocol entity. Server config; a stable key derived from the real path. | Sidebar group header. Exactly one in v1. |
| **Conversation** | The durable product object a user names, returns to, and archives. Holds one or more sessions. | `ConversationId`, `conversation.created` | A sidebar row; the thing the URL addresses. |
| **Session** | One provider-bound run inside a conversation. Carries the provider on `session.created`; owns one model-visible history; owns one durable log and one sequence space. | `SessionId`, `session.created` | Invisible unless it changes. A second session renders as a divider explaining why. |
| **Turn** | One user request and everything the assistant did in response. | `TurnId`, `turn.started` | A user message plus the assistant messages, tool activity, and status that follow it. |
| **Provider step** | One round-trip to the model inside a turn. | `StepId`, `provider.step.started` | Never a transcript entry. It is the **grouping key** for assistant text and for a wave of tool calls. |
| **Message** | Not a protocol entity. A projector concept. | Derived: `user.input.accepted` → user message; `assistant.message.completed` → assistant message. | The transcript's atoms. |

**Can a conversation contain more than one session? Yes**, and this is load-bearing rather than theoretical. `SessionCreated` carries the provider, provider history is session-scoped (B11), and the walkthrough states a conversation may hold several. Multiple sessions are how a conversation survives a model change without forking into a new sidebar row.

**What happens when the provider or model changes.** The server records provider and model on the session. On activation it reuses the newest session only if both match the current config; otherwise it opens a new session in the same conversation. The consequence is real and must be visible rather than silent: the new session's model-visible history starts empty, so the model does not remember the earlier part of the conversation. The transcript renders a `SessionBoundaryItem` saying so. Carrying history across a provider change is a context-transformation problem that belongs to Milestone 5, not here. See Decision 6.

---

## Decisions

### D1 — Durable storage is one JSONL log per session, built on the protocol's existing writer

One append-only JSONL file per session, written through `JsonlSessionLogWriter`, with sequences gapless from 1 inside each file.

This is not a fresh decision so much as executing one already recorded. `implement-sequential-agent-loop/tasks.md`, "Architectural Debt — Forked Provider-History Reducer", says it plainly: *"Build that first sink session-scoped, one log per session, which is what `JsonlSessionLogWriter` already names. Then sequences are gapless within a session, `reduceProviderHistory` works unmodified, the fork is deleted, and hydration becomes 'read this session's log.' … Do not build a global file-backed sink in the meantime."* This change is the work that note was waiting for, and its trigger condition — a file-backed sink existing at all — is now met.

The reference evidence agrees. Codex keeps per-thread JSONL rollout files as the source of truth (`codex-rs/rollout/src/recorder.rs`, `rollout_file_name.rs`) and treats its SQLite layer as a *derived* index backfilled from those files (`rollout/src/state_db.rs`, `metadata.rs`). Truth is the log; the database is an accelerator.

*Alternatives.* **SQLite as the store** — rejected: a native or WASM dependency, a schema to migrate, and it would make the durable log a second-class projection of a database when the protocol already defines the log as canonical. It is the right answer for the *index* at a scale we are nowhere near. **One global append-only log with a conversation filter** — rejected twice over: it is scar #2 and scar #3 in the walkthrough, filtering produces the sequence gaps that forced the forked reducer, and `tasks.md` forbids it by name. **JSONL per conversation rather than per session** — rejected: a conversation's sessions would share a sequence space, so a session-scoped read is again a filtered view with gaps, which is the same trap one level down.

### D2 — `conversation.created` heads every session log, and no reduction ever spans sessions

This settles the wrinkle the debt note left open: *"`conversation.created` spans sessions, so it needs a home."*

Every session log begins with `conversation.created` at sequence 1 and `session.created` at sequence 2. The conversation record carries no title (titles are index-owned; see D4), so the duplication is a fixed two-line header, not duplicated state.

The consequence is a hard invariant: **records from more than one session are never reduced together.** Reducing two logs jointly would report `duplicate_entity` for the conversation, correctly. So the server serves records per session, the client stores them per session, and the client projects per session and concatenates the *projections*. `reduceEngineState` and `reduceProviderHistory` are both run per session and both come out clean.

Why not the alternatives: a **conversation-level header file** holding only `conversation.created` leaves each session log reporting `missing_parent` for its own session, and makes the reduction unit a two-file concatenation with two sequence spaces. **Sequence 1 in the session log being `session.created`** has the same problem. **One session per conversation, always** removes the question but forks the sidebar on every model change, and contradicts the protocol's own model.

This is the decision most likely to be eroded by someone reasonably wanting "give me the whole conversation's records." T11 pins it with a test that joint reduction reports issues, so the constraint is executable rather than remembered.

### D3 — One engine per session, behind a runtime registry

`createAssistantRuntime` becomes `SessionRuntimeRegistry`. A `SessionRuntime` is one `AssistantEngine`, one `RecordEmitter`, one `ApprovalRegistry`, one `TurnRunner`, and one session-scoped `DurableSink`. Provider, tool executor, policy, ids, clock, broadcaster, and conversation store are shared singletons injected into each.

One engine per *session* rather than per conversation, because `DurableSink.append` has no way to choose a log and `RecordEmitter` holds a single `appendChain`. One engine per session makes each of those correct by construction: one engine, one session, one log, one contiguous sequence space, one append chain.

This is the largest server refactor and it repays three inherited defects rather than just enabling the feature:

- **S1** — `accepting()`'s `durable.records().slice(before)` becomes a slice of one session's log, so a command outcome can only contain its own session's records.
- **S3** — append chains are per session, so unrelated conversations stop serializing behind each other, which is what B8 already required.
- **S4** — the idempotency map is per session, so it is per conversation for free.

And it makes the mixing risk structural: a command names a session; the registry resolves that session's engine or rejects with `SESSION_NOT_FOUND`; that engine can only write to that session's log. There is no code path from conversation A's command to conversation B's records.

Registry policy: lazily opened on first use; LRU-capped at 8 open runtimes; a runtime with a running turn or a pending approval is never evicted; idle runtimes close after 10 minutes; closing flushes and releases the log's file handle. `engine.state()` becomes session-scoped and diagnostic-only, which T11 asserts is issue-free.

*Alternative.* **One engine with a routing sink** — rejected: it keeps the single global `appendChain` (S3), keeps the global record slice (S1), and needs a `records()` that cannot answer honestly for a multi-session conversation.

### D4 — Conversations are listed from an append-only index, never by scanning records

`conversations/index.jsonl` holds one line per conversation mutation — `created`, `titled`, `archived`, `unarchived`, `deleted` — folded in file order with last-write-wins per conversation id. Loaded once at startup, held in memory, appended on change, rewritten by atomic `rename` when it exceeds 5,000 lines.

This is the direct answer to "how are conversations listed without scanning every record on every request": the list never touches a record body. Codex reaches the same conclusion from the other direction — `rollout/src/list.rs` encodes the timestamp and id in the *filename* so a listing can sort by `readdir` alone, and `session_index.jsonl` (`rollout/src/session_index.rs`) is an append-only "most recent entry wins" file for exactly the mutable bit, thread names.

Two refinements that fall out:

- **`lastActivityAt` is derived from the newest session log's mtime, not recorded in the index.** Recording it would append a line per turn and make the index the churniest file in the system to save one `stat` per conversation. The cost is that copying a state directory without preserving mtimes reorders the list; that is acceptable and noted.
- **The index is derived and rebuildable.** If it is missing or unparseable, the server reconstructs it from `conversations/*/conversation.json` plus session-log headers, and never modifies a record log doing so. So index corruption degrades to a slow startup, not to lost conversations.

*Alternative.* **Encode title and time in the directory name**, codex-style — rejected here: renaming would mean renaming a directory that holds open file handles, and resolving an id to a path would need a scan. A separate index keeps id→path O(1) and rename a pure append.

### D5 — Conversation state lives outside the workspace

Default `~/.local/state/turnturn` (`$XDG_STATE_HOME/turnturn` when set), overridable with `TURNTURN_STATE_DIR`, namespaced by a key derived from the workspace's real path.

Two reasons, the second of which is the one that matters. It keeps conversation logs out of the user's git status. And it keeps them out of reach of `glob` and `grep`, which walk the workspace root and skip only `node_modules` and `.git` (`workspace/search-tools.ts`). A state directory inside the workspace would feed the model its own past transcripts as search results — a feedback loop that would be confusing to debug and trivially avoided by putting the directory somewhere else.

*Alternative.* `<workspace>/.turnturn`, which is discoverable and travels with the repo — rejected for the search-pollution reason. If we later want project-local state, the tool walker needs an exclusion list first.

### D6 — The server owns durable identity; the client asks to activate

The browser stops minting `conv_`/`sess_` ids and stops sending `conversation.create` / `session.create`. It calls `POST /api/conversations/:id/activate` and receives `{ sessionId, provider, model, isNewSession }`. Client-originated commands narrow to `turn.submit`, `turn.cancel`, and `approval.resolve`.

Durable identity is the server's, because `EngineIds` is the server's. C1 is what happens when it is not: an id minted in a browser tab has the lifetime of that tab, while the records it labels are supposed to outlive the process. Activation is idempotent, and it is the single place where the provider/model comparison from the IA section is made.

This does not weaken the transport law. The server still submits `conversation.create` and `session.create` to the engine as `CommandEnvelope`s through the same serialized boundary; they simply are not client-originated. Approval and cancellation remain commands from the browser, which is what harness Decision 8 required.

*Alternative.* **Keep client-minted ids and add a server-side allowlist** — rejected: it keeps the browser authoritative over durable identity and adds a validation layer to compensate.

`turnId` stays client-minted, with `idempotencyKey`. The client needs a local handle for the optimistic user message before any round-trip completes, and a turn is ephemeral enough that a bad id costs one rejected command.

### D7 — `POST /commands` returns on acceptance, not on turn completion

For `turn.submit` the server calls `engine.submit(command)` without awaiting it, stores the promise in a per-session in-flight map, and responds `202` with `{ kind: "accepted", turnId }`. Everything the turn produces reaches the client through SSE and session-scoped replay.

`engine.submit` for `turn.submit` does not resolve until the turn reaches a terminal state — an explicit, tested decision in `implement-sequential-agent-loop/tasks.md` T2. For a tool-using turn with approvals that is minutes, and a `fetch` held open for minutes is a bad bet against proxies, tab suspension, and laptop sleep. Not awaiting is a *transport* change; the engine contract is untouched, which is why this is preferable to relitigating T2.

The in-flight map preserves B7's "a duplicate arriving while the first is in flight awaits the original promise" at the transport layer, and gives graceful shutdown something to await. `turn.cancel` stays awaited: it should resolve when the turn is genuinely terminal, and `requestCancel` aborts the signal synchronously, so the UI can show "Stopping…" from local state immediately.

*Alternative.* **Keep awaiting and rely on SSE anyway** — rejected: the client cannot distinguish "still running" from "the request died", which is exactly the ambiguity a product client must not have.

### D8 — Live events are filtered by conversation, and the snapshot cursor is per session

`GET /events?conversationId=<id>` is required. Subscribers register with a conversation filter; `publish` delivers an event only when `event.conversationId` matches, plus server-level unscoped warnings. The opening frame becomes:

```
event: snapshot
data: {"conversationId":"conv_…","serverInstanceId":"srv_…",
       "sessions":[{"sessionId":"sess_…","lastSequence":42},{"sessionId":"sess_…","lastSequence":7}]}
```

S7 is the live half of the mixing bug: two tabs on two conversations currently see each other's deltas. The per-session cursor array is Amendment B's resume algorithm carried into a world with more than one sequence space — unchanged in shape, just indexed.

`serverInstanceId` is new and earns its place: a restart is the one event that invalidates the client's live state *and* may have appended repair records (D10) beneath its feet. Without it the client cannot tell a reconnect from a restart, and the browser's automatic `EventSource` retry makes that the common case.

Everything Amendment A and C settled stays: no `id:` field on the stream ever, bounded per-subscriber queues, deltas dropped before durable facts, at most one gap warning per overflow episode with a reserved slot. The `x-turnturn-last-sequence` header (S6) is deleted — `EventSource` cannot read it, so it is a contract the browser can never honour.

The subscriber must be registered **before** reading those cursors. `LiveBroadcaster.subscribeConversation` buffers any event published while its synchronous snapshot callback runs, inserts the snapshot as the first frame, then drains the buffer. Reading cursors first and subscribing afterward loses an event at exactly that boundary; `events-resume.test.mjs` forces that order and fails on the former implementation.

*Alternative.* **One unfiltered stream with client-side filtering** — rejected: it ships every conversation's content to every tab, wastes the bounded queue on events the subscriber will discard, and makes leakage a client-side bug away.

### D9 — Sessions, not the world, are the unit of replay

`GET /records?afterSequence=N` is removed. Replay is `GET /api/conversations/:cid/sessions/:sid/records?afterSequence=N&limit=M`, which returns only that session's records, contiguous and ascending, and refuses a session that does not belong to the named conversation.

S5 with the global endpoint gone. This is also what makes D2's invariant enforceable at the boundary rather than hoped for in the client.

### D10 — An interrupted turn is finalized on open, durably, exactly once

When a session is opened and its log's last turn has no terminal record, the sink appends — under the append lock, before the log is served to anyone — a terminal result for each requested-but-unterminated tool call, a `provider.step.failed` for each running step, then `turn.aborted`. Code `SERVER_RESTARTED`, `synthetic: true` on the tool results. Idempotent: a log already ending in a terminal turn record is left alone.

The alternative of leaving it alone produces a spinner that never stops and a provider history with a tool request that has no result — the malformed conversation invariant 2 exists to prevent, which the next turn would send straight to the provider. Marking it in the UI only would make the display disagree with the log, which is law 1 inverted.

Ordering is innermost-out: tool results, then steps, then the turn. `updateToolTerminal` and `updateTurnTerminal` both reject a second terminal write, so a repair racing anything loses harmlessly. T11 asserts `issues === []` after repair and that a second open appends nothing.

### D11 — A torn log tail is recovered; corruption anywhere else refuses to open

`readSessionLog` already distinguishes a truncated final line (`recoveredCorruptTail: true`) from corruption earlier in the file. The sink uses that: on a torn tail it copies the log to `<name>.corrupt-<iso>`, truncates to the last valid record, and opens at `nextSequence`. On corruption that is not at the tail it reports the conversation unopenable, modifies nothing, and leaves every other conversation usable.

S13 as it stands means one unclean shutdown — the normal way a laptop closes — permanently bricks a conversation, because `JsonlSessionLogWriter.open` throws on any issue. The recovery belongs in the sink because `packages/protocol` is frozen and because "which corruption is recoverable" is a policy question, not a parsing one.

### D12 — `stepId` is carried on assistant text, durable and live

`assistantMessageCompleted` and `contentDelta`/`reasoningDelta` gain `stepId` in scope. No protocol change: `ScopeFields` are optional beyond each type's requirements, `reduceEngineState` ignores `stepId` on those records, and `validateDurableRecord` accepts it.

This is the smallest fix in T0 and the one the most correctness depends on. Without it, live text and its durable message cannot be paired per step, and the only available pairing key is the turn — which is why the current client keeps one assistant message per turn (C3) and stops streaming after step one (C4). With it, supersession is an exact match on `stepId` and "no duplicate assistant text after reconciliation" becomes provable rather than approximate.

### D13 — The projector is a package, not a folder in `apps/web`

A new `packages/chat-client`: view model, projector, reconciliation, tool summarization, client store, transport interface, and HTTP transport. Framework-free, no React, no DOM. Depends only on `@turnturn/protocol` — types plus the record/event type enums, never `@turnturn/protocol/session-log`, which imports `node:fs`. Built with `tsc`, tested with `node --test` on `.mjs` against `dist`, narrow facade in `index.ts` with no `export *` (the rule Decision 12 of the loop design established after `session-provider-history.ts` leaked through a barrel).

Three things this buys that a folder in `apps/web` does not. The projector gets tested with the repo's actual test convention instead of needing a browser runner. Electron and any future CLI reuse it without importing from a React app. And "the projector contains no React" stops being a guideline and becomes a compile boundary.

It also fixes C7 properly. The client gets real `DurableRecord` and `LiveEvent` types with branded ids and typed payloads, which deletes the `String(...)`/`typeof` archaeology in `state.ts`. This slightly widens harness Decision 2, which allowed protocol types only as type-only imports; importing the root entry's enums is a runtime import of a pure module with no Node dependencies. T11 guards it with a test asserting the built bundle references no `node:` builtin.

*Alternatives.* **Three packages** (projection / transport / store) — rejected as one-implementation-deep abstraction; Decision 12's "one adapter deep" rule applies. **Keep it in `apps/web` with vitest** — rejected: it makes the projector's tests depend on a browser runner for no reason, and leaves reuse to copy-paste.

### D14 — The view model is a discriminated union of product elements, keyed stably

`ConversationView.items` is an ordered array of six item kinds — user message, assistant message, tool activity group, approval request, turn status, session boundary — each with a key stable across re-projection. Full interfaces are in "Design Detail: conversation projection".

Gemini-cli arrived at the same shape: `HistoryItem` is a discriminated union including `type: 'tool_group'` carrying `tools: IndividualToolCallDisplay[]` (`gemini-cli/packages/cli/src/ui/types.ts:261`), and `mapCoreStatusToDisplayStatus` (same file, :76) maps engine status onto a smaller display status. Engine vocabulary is translated once, in one place, rather than in each component.

Key stability is not cosmetic. It is what makes "live text replaced by durable text" a key collision rather than an append, which is the mechanism that prevents duplicate assistant text. Keys: `u:<turnId>`, `a:<stepId>`, `t:<stepId>`, `ap:<approvalId>`, `st:<turnId>`, `sb:<sessionId>`.

### D15 — Tool activity groups by `stepId` — one card per provider step

A wave is every tool call sharing a `stepId`, rendered in `providerOrder`.

`tool.requested` carries `stepId`, so the grouping needs no inference. It is also the right product unit: the screenshots show "Ran a command, read postmessagefeedback_test.go ›" as one line covering two tools, which is one step's work. Grouping by turn would merge a five-step investigation into one card; grouping by call reproduces today's event spam.

C5 is the failure this replaces. Two identical `read` calls are two entries because they have two `toolCallId`s; nothing is de-duplicated by formatted text, ever.

### D16 — A pending approval is both a card and part of its tool

The approval lives on `ToolCallView.approval` for the expanded detail, *and* is emitted as a standalone `ApprovalRequestItem` while and only while it is pending. On resolution the standalone item disappears and the outcome shows inside the tool card.

An approval needs to be impossible to miss while it blocks the turn, and needs to leave no permanent clutter once answered. Emitting it as its own item places the card exactly where it happened in the transcript — so approving does not lose the context that produced it — while resolution collapses it back into the card it belongs to.

`Escape` does not resolve an approval. It cancels a running turn everywhere else in the app, and a keystroke that might mean "deny" is a keystroke that will eventually mean "deny something I did not read".

### D17 — `react-markdown` with `remark-gfm` and `rehype-sanitize`, Shiki loaded lazily

Assistant message content renders through `react-markdown` with `remark-gfm` for tables and task lists, `rehype-sanitize` with a restrictive schema, and a custom `code` renderer that highlights with Shiki once it has lazily loaded.

Claude Code's web client is the direct precedent, dependency for dependency: `react-markdown@9`, `remark-gfm@4`, and `shiki` in `claude-code/web/package.json`, wired in `web/components/chat/MarkdownContent.tsx`. All four packages resolve from the registry at current versions (`react-markdown@10.1.0`, `remark-gfm@4.0.1`, `rehype-sanitize@6.0.0`, `shiki@4.4.3`, verified 2026-09-12).

**Why not `marked`, which claude-code also uses.** Claude Code uses `marked` in `src/components/Markdown.tsx` because Ink needs a *token stream* to lay out in a terminal — it never produces DOM. In a browser the equivalent path ends at `dangerouslySetInnerHTML`, and model output is untrusted input. `react-markdown` builds React elements and never parses HTML, so `<script>` and `onerror=` cannot become nodes at all. That is a structural defence, not a filter that has to be right.

Two things worth borrowing from `Markdown.tsx` regardless, both for the same reason it has them: a content-hash-keyed LRU of parsed output (it caches ~3 ms of lexing per message and notes an RSS regression from caching content strings), and a cheap "does this even contain Markdown syntax" pre-check to skip parsing short plain replies.

Streaming needs its own handling or it flickers: while a message is streaming, an unterminated code fence is auto-closed for display only, Shiki is skipped until the block closes, and memoization is keyed on the text prefix. Shiki ships a fixed language subset — ts, tsx, js, jsx, json, python, rust, go, bash, diff, yaml, toml, md, sql, html, css, plus a plain fallback — so the bundle is a decision rather than an accident, and blocks over 2,000 lines or 100 KB render unhighlighted.

### D18 — Tool output is never Markdown

Only `assistant.message.completed` content goes through the Markdown pipeline. Shell stdout, file contents, search matches, and error messages render as literal text in `<pre>`. ANSI escape sequences in shell output are stripped in v1.

Tool output is attacker-influenced in a way assistant text is not: a file in the workspace, or a command's output, can contain anything. Running it through a Markdown renderer means a repository can contain a file that changes how the UI looks when read. The rule is one line to state and removes the whole class.

### D19 — File references are a host-dispatched node, never a `file://` link

A workspace path in assistant text or tool output becomes an anchor with `href="turnturn://file/<relpath>?line=N"` plus `data-workspace-path` and `data-line`, and every click is intercepted by one `FileReferenceProvider` that calls an injected `openFile(ref)`.

Browsers refuse to navigate `file://` from an `http://` page, and emitting one would leak absolute paths into the DOM for no benefit. The `turnturn://` href is never resolved by the browser — the click is always prevented — but it keeps the reference inspectable and copyable, and gives Electron a protocol to register if it wants one.

The handler is the whole point of the indirection:

- **Browser**: no OS integration, so open an in-app read-only peek fed by `GET /api/workspaces/:key/file`, which runs the path through the existing `WorkspacePathGuard`. Offer "Copy path".
- **Electron**: `shell.openPath` or an IDE deep link, through the preload bridge.

Bare paths in prose are matched by a small remark plugin over text nodes only, never inside `code` or `inlineCode`. Conservative pattern — a relative POSIX-ish path with an extension or a separator, optionally `:line` or `:line:col`. A false negative is a plain string; a false positive mangles prose, so the bias is toward missing some.

The client never resolves a path. It sends the workspace-relative string and the server confines it.

### D20 — No virtualization; window by "most recent 300, load earlier"

The transcript renders at most the newest 300 items, with a "Load earlier" control above them. Items memoize on identity; Markdown output is cached by content hash.

Claude Code's web client does virtualize (`@tanstack/react-virtual` in `web/components/chat/VirtualMessageList.tsx`), so this is a deliberate divergence. Virtualizing variable-height content that is *also* growing character by character during streaming is the standard recipe for scroll jitter and measurement thrash, and scroll correctness is an explicit goal of this milestone. A 300-item window is a fixed DOM bound achieved with none of that machinery. If profiling later shows it is not enough, `@tanstack/react-virtual` is the follow-up and the item list is already the right shape for it.

### D21 — Transport is an interface with one implementation

`ChatTransport` in `packages/chat-client` declares conversation listing and lifecycle, session replay, live subscription, and command submission. `HttpChatTransport` implements it with `fetch` and `EventSource`. No React component imports it; components see the store.

This is the Electron seam, and it is the one place where designing for a second implementation is justified now rather than later: codex's `app-server` keeps one protocol behind four transports (`app-server-transport/src/transport/{stdio,unix_socket,websocket,remote_control}`) precisely so the transport is swappable, and the harness research already flagged that as the property to preserve. It also gives the tests a fake transport, which is how the conversation-mixing test runs without a server.

### D22 — Developer mode reads the store and cannot write to it

The developer drawer is off by default, enabled by `?dev=1`, a keyboard chord, or the sidebar footer, persisted in `localStorage`. It subscribes to the same store the product UI uses, through read-only selectors, and is constructed with no access to the store's mutators.

Law 8 says debug state must not become the application state source. The way that law gets broken is not by a decision; it is by a debug panel acquiring a "reset" button because it was convenient. Making the drawer structurally incapable of dispatching is cheaper than reviewing for it, and T11 asserts no module under `developer/` imports a mutator.

Contents: connection state and `serverInstanceId`; the selected session's durable records; a bounded ring of the last 200 live events with superseded ones marked; projection diagnostics; `reduceEngineState` issues for that session; the tool catalog as sent to the provider; the last provider request body with headers stripped server-side; and copy-as-JSON for a bug report.

The last provider request body is **not yet available** from the server. The body is built inside the chat-completions adapter; the server's provider port only sees normalized history and tools. An exact diagnostic would require an additive observer in the exported adapter options, and therefore the full contract-altering gate. Rebuilding the JSON in the server would be an inaccurate, drifting duplicate; global `fetch` interception could expose authorization headers. Open Question 4 asks whether to do the full gate for this developer-only view or defer it. Any eventual route must require both conversation and session ids, validate their relationship, and return body only, never headers.

### D23 — `Host` and `Origin` validation plus a per-process token, required

Every request: reject unless `Host` is the loopback address or `localhost` with the configured port. Every state-changing request (`POST`, `PATCH`, `DELETE`): reject unless `Origin` equals the server's own origin. Every `/commands` and `/api/*` request: reject unless it carries `X-Turnturn-Token` matching a 256-bit token generated at startup. No `Access-Control-Allow-Origin` header, ever.

S9 is not a theoretical hardening item. `shell` is reachable through this server, it is unconfined by design until Milestone 4's sandbox (B17 states this plainly), and the server answers unauthenticated requests on a predictable loopback port. Any web page the user visits can therefore run commands on their machine via DNS rebinding. `Host` validation closes rebinding; `Origin` validation closes the cross-origin `POST`; the token closes the remaining case neither covers, which is another program on the same machine. Each is a few lines, and the third is the only one that survives "the attacker is not a browser".

Delivery: the server injects `<script>window.__TURNTURN__={token:"…"}</script>` into `index.html` when it serves it. Under `vite dev` the page is served by Vite, so the token comes from `VITE_TURNTURN_TOKEN`, which the CLI prints at startup. `EventSource` cannot set headers, so `/events` takes the token as a query parameter — noted as a tradeoff, mitigated by the server having no request log.

*Alternative.* **`Host`/`Origin` only, no token** — rejected: it leaves a local-process path to `shell` open. **A token only** — rejected: it leaves a rebinding page able to read the token out of the page if any same-origin hole exists. Both, or neither is worth much.

### D24 — Titles come from the first message, and a rename wins forever

The title is derived from the first user message: first non-empty line, whitespace collapsed, mention and fence syntax stripped, truncated to 60 characters at a word boundary. Until then the conversation has no title and the sidebar shows "New conversation". An explicit rename sets `titleSource: "manual"` and derivation never overwrites it.

Codex does the same thing for the same reason — `ThreadItem.first_user_message` in `rollout/src/list.rs` is the preview, and thread names are a separate append-only override in `session_index.rs`.

*Alternative.* **Ask the model for a title** — rejected for v1: an extra provider call per conversation, latency on the first message, cost, and nondeterminism in a surface we want reproducible in tests. It is a good v1.x addition behind the same index entry, since `titleSource` already distinguishes the cases.

### D25 — Two new contract surfaces, named as such

This change creates an on-disk storage layout and a client-facing HTTP API. Neither existed, so neither is *altered* and the standard gate applies. Both are contracts the moment they ship: the layout because a user's conversations live in it, the API because a separately deployed client would pin it. An exact provider-request observer would instead alter the exported adapter options and trigger the full gate; it remains an open decision.

So: `storageVersion` in `meta.json` from day one, with an ordered migration mechanism and a refusal to open a newer version (D26); and the recorded position, carried forward from harness Amendment D, that **the first separately deployed client is the trigger to version the client-facing protocol separately** — codex's `app-server-protocol/src/protocol/v1.rs`, `v2/`, and `schema_fixtures.rs` are what that looks like. Until then `/api` reuses internal types and `SCHEMA_VERSION` alone.

The first change to either surface is contract-altering and needs `research/neutral-challenge.md` and `research/synthesis.md`.

### D26 — Storage version refuses forward, migrates backward, one step at a time

`meta.json` holds `{ "storageVersion": 1 }`. Absent or empty directory: initialize at the current version. Higher than supported: refuse to start, naming both versions, having read and written nothing. Lower: run ordered `n → n+1` migrations, each a pure function over the directory, with the index backed up first.

v1 has no migrations, so the deliverable is the mechanism plus a test that a future version refuses to boot. That test is the whole value: the failure it prevents is an older build silently half-reading a newer layout, which is how conversations get corrupted rather than lost.

Record-level versioning already exists and is left alone — `DurableRecord.schemaVersion` is `1` and `validateDurableRecord` rejects anything else.

---

## Design Detail

### Conversation projection

**Data flow.**

```text
                    per session
  ┌──────────────────────────────────────────────────────────┐
  │  GET /api/conversations/:c/sessions/:s/records  (durable)│
  │  GET /events?conversationId=:c                  (live)   │
  └──────────────────────────────────────────────────────────┘
                              │
                              ▼
              ConversationStore   (packages/chat-client)
              ├─ Map<SessionId, SessionSlice>
              │    records: gapless 1..lastSequence
              │    live:    not-yet-superseded events
              └─ conversation metadata, connection state
                              │
                   reconcile(slice)      ← pure, drops superseded live events
                              │
                   projectSession(slice) ← pure, per session
                              │
                   concatenate by session ordinal
                              ▼
                      ConversationView
                              │
                    useSyncExternalStore
                              ▼
                     React components
```

**View model.** Illustrative, not final code:

```ts
export type ConversationViewItem =
  | UserMessageItem | AssistantMessageItem | ToolActivityGroupItem
  | ApprovalRequestItem | TurnStatusItem | SessionBoundaryItem;

interface ItemBase {
  readonly key: string;            // stable across re-projection; see D14
  readonly sessionId: SessionId;
  readonly order: OrderKey;        // [sessionOrdinal, anchorSequence, tiebreak]
}

export interface AssistantMessageItem extends ItemBase {
  readonly kind: "assistant-message";
  readonly turnId: TurnId;
  readonly stepId: StepId;         // present on both paths after D12
  readonly text: string;
  readonly source: "durable" | "live";
  readonly streaming: boolean;
}

export interface ToolActivityGroupItem extends ItemBase {
  readonly kind: "tool-activity";
  readonly turnId: TurnId;
  readonly stepId: StepId;                    // the grouping key, D15
  readonly summary: string;                   // "Searched for “ToolExecutorPort” in 8 files"
  readonly status: "running" | "awaiting-approval" | "completed"
                 | "partial-failure" | "failed" | "denied" | "aborted";
  readonly calls: readonly ToolCallView[];    // providerOrder
}

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;                  // validated input, as recorded
  readonly status: "requested" | "awaiting-approval" | "running"
                 | "completed" | "failed" | "denied" | "aborted";
  readonly headline: string;                  // "Read apps/web/src/App.tsx (237 lines)"
  readonly detail: ToolCallDetail;
  readonly requiresApproval: boolean;
  readonly approval?: ApprovalView;
  readonly error?: SerializedError;
  readonly cancellation?: { readonly requested: true; readonly reason?: string };
  readonly synthetic: boolean;                // engine-produced, not tool-produced
  readonly durationMs?: number;
  readonly progress: readonly string[];       // live tool.progress
  readonly streamedOutput?: string;           // live stdout/stderr, capped
}

export type ToolCallDetail =
  | { presentation: "file-read";  path?: string; content?: string; startLine?: number; lineCount?: number }
  | { presentation: "file-write"; path?: string; bytesWritten?: number }
  | { presentation: "file-edit";  path?: string; oldText?: string; newText?: string; replacements?: number }
  | { presentation: "search";     query?: string; matches: readonly SearchMatchView[]; truncated: boolean }
  | { presentation: "paths";      pattern?: string; paths: readonly string[]; truncated: boolean }
  | { presentation: "shell";      command: string; cwd?: string; stdout?: string; stderr?: string;
                                  exitCode?: number; truncated: boolean }
  | { presentation: "json";       value: JsonValue };

export interface ConversationView {
  readonly conversationId: ConversationId;
  readonly items: readonly ConversationViewItem[];
  readonly activeTurn?: { turnId: TurnId; phase: TurnPhase; canStop: boolean };
  readonly pendingApproval?: ApprovalRequestItem;
  readonly diagnostics: readonly ProjectionIssue[];   // dev-only; never affects rendering
}

export type TurnPhase =
  | "idle" | "waiting-for-model" | "generating"
  | "awaiting-approval" | "executing-tools" | "finishing";
```

`ToolCallDetail` is shaped around what the tools actually return, read from `workspace/file-tools.ts`, `search-tools.ts`, and `shell-tool.ts` — not around B16's shared `{content, truncated, originalBytes}` envelope, which is specified but unimplemented. If B16 lands later the projector gains one more `presentation`; nothing else moves.

**How the event sequence in the brief becomes one element.** Durable order within a step, from `provider-step-runner.ts` and `tool-wave-runner.ts`:

```text
provider.step.started         step_7           →  phase: waiting-for-model
  content.delta ×N (live)     step_7           →  AssistantMessageItem{source:"live", streaming:true}
assistant.message.completed   step_7           →  AssistantMessageItem{source:"durable"}  (supersedes the above)
provider.step.completed       step_7 tool-use  →  (no item; sets phase)
tool.requested                step_7 tool_a    →  ToolActivityGroupItem key t:step_7, calls:[a]
  approval.requested                  appr_1   →  ApprovalRequestItem + calls[a].approval
  approval.resolved                   appr_1   →  approval item removed; calls[a].approval updated
tool.result.completed                 tool_a   →  calls[a].status = completed, detail filled
provider.step.started         step_8           →  next step
assistant.message.completed   step_8           →  AssistantMessageItem key a:step_8
```

Collapsed, that step is two elements: one assistant message and `▸ Searched for "ToolExecutorPort" in 8 files`. Expanding the group reveals the call's input, output, duration, error, and approval history. The step itself is never an element.

**Group summary algorithm.** Deterministic, no cleverness. Bucket calls by verb — Read / Wrote / Edited / Searched / Found files / Ran — render each bucket as `<verb> <count> <noun>` when the count is above one and as the single call's headline otherwise, join with `", "`, sentence-case the first, cap at 90 characters and ellipsize. Adornments for `(needs approval)` and `(1 failed)`. Table-driven tests, one row per case.

**Order key.** `[sessionOrdinal, anchorSequence, tiebreak]`, totally ordered. Durable items anchor on their record's sequence. Live-only items anchor on `lastSequence + 1` with `tiebreak` from a monotonic local counter, so they sort at the tail in arrival order. A pending user message anchors the same way and is superseded by its `turn.started` record.

### Durable ↔ live reconciliation

```ts
interface SessionSlice {
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly provider?: string;
  readonly model?: string;
  readonly records: readonly DurableRecord[];   // contiguous 1..lastSequence
  readonly lastSequence: number;
  readonly hasGap: boolean;
  readonly live: readonly LiveEvent[];          // not yet superseded
}
```

**Ingesting a durable record.**

1. Reject it if `record.sessionId` is not this slice's — raise `foreign-session` and drop. This is D2's invariant at the client boundary.
2. If `record.sequence <= lastSequence`: it is a redelivery. Keep the held record; if the `recordId` differs, raise `sequence-conflict`. Never overwrite, never renumber.
3. If `record.sequence === lastSequence + 1`: append.
4. If `record.sequence > lastSequence + 1`: set `hasGap`, do not append, request `afterSequence=lastSequence`. **Project only up to `lastSequence`.** A gap is a fetch to make, never a hole to fill.

**Ingesting a live event.** Append to `live`, then run supersession.

**Supersession**, by fact identity rather than by `recordId`, because non-terminal live events have none:

| Live event | Dropped once a durable record exists |
|---|---|
| `content.delta`, `reasoning.delta` | `assistant.message.completed` with the same `stepId` (D12) |
| `tool.started`, `tool.progress`, `stdout.delta`, `stderr.delta` | any terminal `tool.result.*` for that `toolCallId` |
| `tool.completed`, `tool.failed` | any terminal `tool.result.*` for that `toolCallId` |
| `approval.requested` / `approval.resolved` | the matching durable record for that `approvalId` |
| `turn.started` | `turn.started` for that `turnId` |
| `turn.completed` / `failed` / `aborted` | any terminal turn record for that `turnId` |
| `warning` | never — no durable counterpart; bounded ring of 50, developer mode only |

**Two rules that close the remaining gaps.**

*Live text is retained until its durable message arrives, even after the turn looks finished.* The client can receive `turn.completed` (live) before it has fetched the durable assistant message, so clearing streaming state on turn terminality alone would flash the text away. Every terminal turn live event therefore triggers a records refetch, and the live text stays until supersession or rule two.

*Live deltas for a turn are dropped once the client holds that turn's terminal durable record.* B1 guarantees accumulated text is written **before** `provider.step.failed`, so if the durable log through the turn's terminal record contains no message for a step, there was no text to persist. Dropping is then provably correct. Dropping non-empty live text with no durable counterpart raises `live-text-unbacked`, which turns a B1 violation into a visible diagnostic instead of silently lost words.

**Resume, per session.** Amendment B unchanged in shape:

```text
1. open GET /events?conversationId=C          ← first, always
2. receive snapshot { serverInstanceId, sessions:[{ sessionId, lastSequence }] }
3. buffer arriving live events
4. per session: GET …/records?afterSequence=<held>, take records up to lastSequence
5. apply the buffer
```

If `serverInstanceId` differs from the last seen value: discard all live state, keep durable records, and refetch every session from its held sequence — repair records from D10 arrive through that same path.

**Projector invariants worth testing.** Listed with their tests in "Testing strategy": session isolation, conversation isolation, no duplicate assistant text, multi-step ordering, exactly-one-terminal-per-request, wave grouping, approval lifecycle including resolution-after-cancellation, no turn resurrection, gap handling, redelivery idempotence, order stability, optimistic supersession, cancellation metadata, synthetic distinction, summary formatting, and phase derivation.

### Server persistence layout

```text
$TURNTURN_STATE_DIR                     default ~/.local/state/turnturn        (D5)
  meta.json                             { "storageVersion": 1 }                (D26)
  .lock                                 { pid, startedAt, port }               exclusive, D1
  workspaces/<workspaceKey>/            sha256(realpath(workspace)) prefix
    workspace.json                      { path, createdAt }
    conversations/
      index.jsonl                       append-only, last-wins per id          (D4)
      <conversationId>/
        conversation.json               { conversationId, workspaceKey, createdAt, storageVersion }
        sessions/<ordinal>-<sessionId>.jsonl     ordinal zero-padded → readdir sorts
        archived/                       sessions moved here on archive
```

Session files are prefixed with a zero-padded ordinal so session order comes from `readdir` and a lexical sort, with no file reads — the same trick as codex's `rollout-<timestamp>-<id>.jsonl`.

**Index entries.** `created`, `titled` (with `titleSource: "auto" | "manual"`), `archived`, `unarchived`, `deleted`. No `touched`: `lastActivityAt` is the newest session file's mtime (D4).

**Module shape** in `packages/assistant-server/src/`:

```text
storage/state-dir.ts        resolve, lock, meta.json, migrations
storage/conversation-index.ts   append + fold + compact + rebuild
storage/conversation-store.ts   create/open/rename/archive/delete, session activation
storage/session-sink.ts     JsonlSessionDurableSink: DurableSink over JsonlSessionLogWriter,
                            log header (D2), tail recovery (D11), repair on open (D10)
session-runtime.ts          SessionRuntime + SessionRuntimeRegistry               (D3)
api/*.ts                    route handlers, one file per resource
security.ts                 Host/Origin/token validation                          (D23)
```

`RecordEmitter` gains `seedSessionRecords(sessionId, records)` so a hydrated log populates `recordsBySession` and provider history sees prior turns. That plus D1 is what lets `session-provider-history.ts` be deleted and `reduceProviderHistory` be used unmodified.

### API surface

Unchanged: `POST /commands`, `GET /events`. Removed: `GET /records`, `GET /debug/state`. Added under `/api`. Every request is subject to D23.

```http
GET /api/runtime
→ 200 { workspace: { key, path, name }, provider: "openai-chat-completions",
        model: "bedrock-claude-5-sonnet", baseUrlHost: "litellm.test.asapp.com",
        maxTokens: 4096, serverInstanceId: "srv_…", storageVersion: 1, schemaVersion: 1,
        tools: [{ name: "read", description: "…", mutating: false }, …] }
        # never apiKey; never the full baseUrl                                    (S8, D23)

GET /api/conversations?archived=false&limit=100&cursor=…
→ 200 { conversations: [{ conversationId, workspaceKey, title: null,
                          titleSource: "auto", createdAt, lastActivityAt,
                          archived: false, sessionCount: 1 }], nextCursor: null }

POST /api/conversations              { workspaceKey, title? }
→ 201 { conversation: { … } }        # no session yet                             (D6)

GET /api/conversations/:conversationId
→ 200 { conversation: { … },
        sessions: [{ sessionId, ordinal, provider, model, createdAt, lastSequence }] }

POST /api/conversations/:conversationId/activate
→ 200 { sessionId, ordinal, provider, model, isNewSession: false }                (D6)

PATCH  /api/conversations/:conversationId    { title?, archived? }
→ 200 { conversation: { … } }

DELETE /api/conversations/:conversationId
→ 204 | 409 { error: { code: "CONVERSATION_NOT_ARCHIVED" } }

GET /api/conversations/:cid/sessions/:sid/records?afterSequence=0&limit=1000
→ 200 { sessionId, records: [DurableRecord], lastSequence: 42, hasMore: false }   (D9)
→ 404 { error: { code: "SESSION_NOT_IN_CONVERSATION" } }

GET /api/workspaces/:workspaceKey/file?path=src/a.ts&start=1&end=200
→ 200 { path, start, end, lineCount, content } | 403 PATH_OUTSIDE_WORKSPACE
                                              | 415 NOT_TEXT | 413 TOO_LARGE      (D19)

GET /api/debug/state?conversationId=&sessionId=
→ 200 { engineStateIssues, providerHistoryIssues, lastSequence }                  (D22)

GET /api/debug/provider-request?conversationId=&sessionId=
→ 200 { body }                       # headers stripped server-side               (D23)

POST /commands                       CommandEnvelope
→ 202 { kind: "accepted", turnId }              for turn.submit                   (D7)
→ 200 { kind: "accepted" | "duplicate" | "rejected", … }  otherwise
→ 404 { error: { code: "SESSION_NOT_FOUND" } }                                    (D3)

GET /events?conversationId=…&token=…
→ 200 text/event-stream, opening `event: snapshot` frame, never an `id:` field    (D8)
```

`apps/web/vite.config.ts` proxies `/api`, `/commands`, and `/events` to `127.0.0.1:8787`, fixing C8.

### Component hierarchy

```text
<App>
 ├─ <TransportProvider>          connection lifecycle, serverInstanceId, reconnect, token
 ├─ <RuntimeProvider>            /api/runtime once: workspace, provider, model, tool catalog
 ├─ <ConversationListProvider>   list + lifecycle + selection + URL sync
 └─ <AppShell>
     ├─ <Sidebar>                workspace group · New conversation · list · footer (settings, dev)
     ├─ <MainColumn>
     │   ├─ <ConversationHeader> inline-editable title · workspace chip · model chip · phase · menu
     │   ├─ <ConversationViewport>
     │   │   ├─ <LoadEarlier>            (D20)
     │   │   ├─ <UserMessage> <AssistantMessage> <ToolActivityCard>
     │   │   ├─ <ApprovalCard> <TurnStatus> <SessionDivider>
     │   │   ├─ <ApprovalBanner>         when a pending approval is off screen
     │   │   └─ <JumpToLatest>
     │   └─ <Composer>           textarea · Send/Stop · phase line · workspace+model footer
     └─ <DeveloperDrawer>        only when dev mode is on                          (D22)
```

| Surface | Owns | Must not |
|---|---|---|
| Sidebar | Workspace grouping, conversation list, create/rename/archive/delete, selection | Know about turns, records, or transport |
| Header | Title editing, configuration display, phase and connection summary, conversation actions | Hold transcript state |
| Viewport | Item rendering, scroll anchoring, expansion state, approval visibility | Interpret records or events |
| Tool card | Collapsed summary, expansion, per-presentation detail, output bounding | Decide tool status — the projector does |
| Composer | Draft text, key handling, Send/Stop/Retry/Continue dispatch | Know command envelope shape (the store does) |
| Developer drawer | Diagnostics display | Dispatch anything |

**Responsive.** ≥1100px: sidebar 260px plus main plus optional drawer. 768–1100px: sidebar becomes an overlay behind a menu button; the drawer becomes a full-width overlay. <768px: header condenses to title and menu; the composer pins to the bottom respecting `env(safe-area-inset-bottom)`.

**URL and local state.** The URL holds the selected conversation (`/c/:conversationId`) and `?dev=1`. Nothing else: those are the only two pieces worth bookmarking or restoring. `localStorage` holds the last conversation id (for a bare `/`), per-conversation draft text, sidebar collapse, and dev-mode preference. Expanded tool cards are deliberately not persisted — restoring them would rebuild a large DOM on every open.

**Restoring selection after refresh.** URL id if present and loadable → else stored id if still listed → else most recently active → else first-run empty state.

**Empty, loading, and failure states.** First run: workspace path, one line of orientation, focused composer; the first send creates the conversation. Loading: skeleton rows, not a spinner. Existing but empty: workspace and model line plus a focused composer. Disconnected: sticky bar, transcript stays readable, Send unavailable with the reason. Unopenable conversation: inline message with Retry and Back, sidebar still usable. After a restart: the repair records from D10 render as an aborted turn status and a session divider — no modal.

### Interaction detail

**Keys.** `Enter` sends when the composer is non-empty and no turn is running. `Shift+Enter` inserts a newline. `Cmd/Ctrl+Enter` always sends. `Escape` cancels a running turn; with no turn running it closes the open drawer or overlay; it never resolves an approval (D16). `Cmd/Ctrl+K` focuses the composer. `Cmd/Ctrl+Shift+D` toggles developer mode.

**Composer availability.** Never disabled for typing. `Enter` while a turn is running is a no-op with a stated reason and the text preserved — queued turns are out of scope, and the harness task list already flagged duplicate-submit suppression as unfinished. Send is unavailable while the transport is disconnected.

**Stop.** Replaces Send whenever `activeTurn` exists. On click: local state goes to `stopping`, `turn.cancel` is submitted, and the turn continues to display as running until its terminal durable record arrives. After 10 seconds without one, the label explains that a tool may still be finishing. A terminal state is never displayed before the record exists — that is law 1 at the interaction layer.

**Retry and continue.** Retry appears on a failed turn whose `SerializedError.retryable` is true, and submits a **new** turn with the same text and a fresh `turnId`; it never reopens the failed turn, because a terminal turn does not resurrect. Continue appears when a turn ended with `stopReason` `"output-limit"`, or aborted, and submits a new turn asking to continue. Both are marked in ephemeral local state only — the protocol has no field for "this retries that", so after a refresh they read as two ordinary user messages. Honest and cheap; a durable link would be a protocol change.

**Scrolling.** Pinned while within 48px of the bottom. A user scroll away unpins and reveals a "Jump to latest" pill carrying a count of items that arrived since. Clicking it scrolls and re-pins. The viewport is never moved while unpinned — including for an arriving approval, which instead raises the off-screen approval banner.

### Error and recovery behaviour

| Condition | Source | Presentation | Recovery |
|---|---|---|---|
| Turn failed, retryable | `turn.failed`, `error.retryable` | Turn status with code and message, Retry offered | New turn |
| Turn failed, fatal | `turn.failed` | Same without Retry | Manual |
| Provider step failed mid-turn | `provider.step.failed` | Inline note inside the turn; the turn's own terminal record governs | Retry if the turn is retryable |
| Tool failed | `tool.result.failed` | Inside the tool card; the turn continues | None needed — the model sees it |
| Tool denied / aborted | `tool.result.denied` / `aborted`, `synthetic` | Distinguished from a real tool error | — |
| Approval refused late | `APPROVAL_NOT_PENDING` | Card shows cancelled, not an error toast | — |
| Command rejected | `SESSION_NOT_FOUND`, `TURN_NOT_RUNNING` | Non-blocking notice; state resynced from the server | Reactivate |
| Event stream dropped | `EventSource` error | "Reconnecting", transcript readable, Send unavailable | Browser retry, then resume (D8) |
| Server restarted | `serverInstanceId` changed | Session divider plus the aborted turn from D10 | Automatic |
| Sequence gap | Projector | Nothing derived past the gap; transcript shows up to `lastSequence` | Automatic refetch |
| Live queue overflowed | `warning` `LIVE_QUEUE_OVERFLOW` | Developer mode only | Automatic refetch |
| Conversation unopenable | 404/500 or D11 | Inline, sidebar usable | Retry / Back |

### Electron reuse strategy

What ships here is already the Electron split. `packages/chat-client` holds everything but rendering and has no DOM or Node dependency. `apps/web` holds components. The renderer reaches the engine only through `ChatTransport` (D21).

An Electron shell then needs: the main process to host `assistant-server` in-process (it already composes as a library — `createAssistantRuntime` plus `createAssistantHttpServer`); an `IpcChatTransport` implementing `ChatTransport` over `contextBridge`, at which point `Host`/`Origin`/token validation is replaced by process boundary rather than removed; and an `openFile` handler using `shell.openPath` (D19). No component changes, no projector changes.

Two things are deliberately not solved: the client-facing protocol stays internal until a client ships separately from the server (D25), and there is no packaging, updater, or window state work here.

---

## Security Boundaries

**Credentials.** `TURNTURN_API_KEY` is read in `cli.ts`, handed to the adapter, and excluded from `publicConfig` today — verified. This change tightens it further: `/api/runtime` reports `baseUrlHost` rather than `baseUrl` (S8), and `/api/debug/provider-request` strips request headers server-side so the `Authorization` header is never serialized toward the browser. T11 asserts that no response body from any endpoint contains the configured key.

Hygiene note, not a code finding: `.env.local` is gitignored and untracked, and `git grep` confirms the key appears in no tracked file. `.env.example` is present on disk, untracked, and contains a real-looking key — replace its values with placeholders before it is ever committed.

**Localhost assumptions.** Bind `127.0.0.1`. Single local user. No multi-tenancy, no TLS, no audit log. What that does *not* buy is safety from the local browser, which is why D23 is required rather than deferred: `shell` is unconfined until Milestone 4, so a predictable unauthenticated loopback port is a remote code execution path via DNS rebinding.

**Before browser-triggered filesystem and shell tools are acceptable**, all of: `Host` validation, `Origin` validation on state-changing requests, the per-process token, no CORS headers, approval-gated `shell` with the command rendered verbatim and unparsed in the approval card, path confinement through the existing realpath-resolving `WorkspacePathGuard` on every server-side file read, and the standing acknowledgement that policy is not containment. Milestone 4's sandbox is what changes that last line.

**Untrusted model output.** No raw HTML (`react-markdown` never parses it; `rehype-sanitize` as a second layer). Link schemes limited to `http`, `https`, `mailto`, `turnturn`; anything else renders as text, so `javascript:` and `data:` cannot become links. External links get `rel="noopener noreferrer nofollow"`. **Images are disabled** and render as links — an `<img src>` in model output is a network beacon that leaks conversation content to whoever controls the host. Tool output is never Markdown (D18) and ANSI is stripped. A strict `Content-Security-Policy` ships on the built app — `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:` — so exfiltration fails even if a sanitizer bug slips through.

**Paths.** Rendered as text, always escaped by React. Never resolved client-side. Every server-side read goes through `WorkspacePathGuard`, which resolves symlinks before confining, and refuses non-UTF-8 or oversized files.

**Origin validation and tokens for Electron or remote hosting.** Both are required now, before either (D23). For remote hosting they are necessary and not sufficient — that needs real authentication, TLS, per-user state directories, and a sandbox, and is explicitly out of scope.

---

## Testing Strategy

Convention: `node --test` on `.mjs` against built `dist` for `packages/*`. `apps/web` needs a DOM, which `node --test` does not provide, so it gets `vitest` with `happy-dom` and `@testing-library/react` — a stated deviation, confined to the one package that cannot follow the rule, and it also fixes C9's zero-test script.

**Projector unit tests** — `packages/chat-client`, `node --test`. One per invariant: session isolation (a foreign-session record is rejected with a diagnostic, never displayed); conversation isolation (two conversations with overlapping sequence numbers project independently); no duplicate assistant text (deltas then the durable message yield exactly one item carrying durable text); multi-step ordering (text/tools/text/tools with stable keys); tool pairing (every request has exactly one terminal status; a request with no result shows running; a second terminal record is ignored with a diagnostic); wave grouping by `stepId` in `providerOrder`; approval lifecycle including resolution after cancellation; no turn resurrection (a post-terminal record raises a diagnostic and does not change status); sequence gap (nothing past the gap, refetch requested, nothing renumbered); redelivery idempotence (the same record twice, deep-equal view); order stability (re-projection preserves keys and order; an appended record never reorders earlier keys); optimistic supersession; cancellation metadata rendering as completed-after-cancel rather than as an error; `synthetic` distinguishable from a real tool error; table-driven summary formatting for all six tools plus unknown; phase derivation per engine state. Plus D2's guard: joint reduction of two session logs reports issues, so the constraint is executable.

**Component tests** — `apps/web`, vitest. Markdown rendering (headings, lists, tables, inline and fenced code, copy button, a `javascript:` link rendered as text, raw HTML stripped, no `<img>`); streaming with an unterminated fence; tool cards for all six presentations including collapsed summary, expansion, the output cap and "show all", failed, denied, aborted, and a non-zero shell exit showing output; approval card dispatch, disabled-while-resolving, cancelled terminal state, and the command rendered verbatim and unparsed; composer key handling, Enter-while-running no-op, Send→Stop→Stopping, disconnected state; retry offered only when retryable. Scroll behaviour is asserted on the pinned/unpinned state rather than on pixels, because happy-dom has no layout — stated rather than pretended.

**Accessibility** — axe-core on the shell with no violations; keyboard traversal reaching list, header, transcript, tool expansion, approval choices, and composer; `aria-live="polite"` on the streaming region and phase; `aria-expanded` on tool cards; accessible names on every icon-only control; visible focus; `prefers-reduced-motion` honoured.

**Transport resume and race tests** — `packages/chat-client` against a real local `assistant-server`, `node --test`, no browser. The Amendment B test under concurrent appends, asserting every record is observed **exactly once** per session — this is the box `implement-web-client-harness/tasks.md` still has unchecked, and it is finished here because this design depends on it. Plus: no `id:` on the stream; `?conversationId=A` never delivers a B event; a non-reading subscriber does not stall a turn; `serverInstanceId` change forces a full refetch and clears live state. And the strongest single test in the suite: **disconnect mid-turn, reconnect after it completes, and assert the projected view is identical to that of a client that never disconnected.**

**Persistence and restart tests** — `packages/assistant-server`. Round-trip across a restart with records byte-identical, sequences contiguous, and both reducers issue-free. Interrupted-turn repair, exact records, idempotent on second open. Torn tail recovered with the original preserved; mid-file corruption refusing to open without modifying anything. Rename and archive surviving restart; index deleted and rebuilt; unknown `storageVersion` refusing to boot; a second process refusing the lock. Listing cost flat at 200 conversations × 500 records — a scan-based implementation fails this by timing alone.

**Conversation-mixing test** — `apps/web`, vitest. Mount the real `AppShell` against a **fake `ChatTransport`** serving two conversations whose sessions both number 1..20, since overlapping sequences are the realistic hazard. Assert A shows only A, B shows only B, switching back to A shows no B content, and a live event for B arriving while A is displayed appears nowhere. This is not a real browser: it proves scoping, not layout. A Playwright version is the follow-up and is out of scope.

**No-duplicate-contract guard, enforced by CI, not by review.** C7 (`apps/web/src/protocol.ts`) is a hand-duplicated `CommandEnvelope`/`DurableRecord`/`LiveEvent`, typed independently of `@turnturn/protocol`, with no compiler check that the two agree — that is how the branded ids and payload types silently disappeared. Task 5.2's "verify no module under `apps/web/src` declares a protocol type" is a one-time migration check; it does not stop the same duplication from being reintroduced six months from now by someone who cannot import `@turnturn/protocol` easily (e.g. a bundler config issue) and reaches for "just retype the three shapes locally" as the path of least resistance. This gets a standing, automated guard, not a one-time verification: a script (`scripts/check-no-protocol-duplication.mjs`, run in the root `pnpm check` alongside `lint`) that fails if any file outside `packages/protocol` declares a type or interface named `CommandEnvelope`, `DurableRecord`, `LiveEvent`, or `CommandOutcome`, and that fails if `apps/web/package.json` does not list `@turnturn/protocol` as a dependency. This is cheap (a regex over `git ls-files '*.ts' '*.tsx'`, not an AST pass) and it is the only thing in this design that makes C7's fix durable rather than a snapshot-in-time.

**Live LiteLLM acceptance** — `scripts/acceptance-chat.mjs`, excluded from the default run, gated on `TURNTURN_ACCEPTANCE=1`. Drives the real server over HTTP exactly as the browser does: activate, submit "Find where ToolExecutorPort is defined, then read that file and summarise it", answer any approval, wait for `turn.completed`. Asserts at least two provider steps, at least one tool with a terminal result, both reducers issue-free, a non-empty final assistant message, and a projected view containing at least one tool-activity group. Then restarts the server and asserts the projected view is unchanged. This is the test S12 currently makes impossible, which is why S12 is in T0.

**Minimum manual acceptance flow.** 1. Start the server; confirm the banner prints workspace, provider, model, and token. 2. Open the app; confirm no timeline, no raw JSON, no Initialize button. 3. Send a message; confirm the user bubble appears immediately and text streams. 4. Confirm no duplicated text when streaming ends. 5. Ask for something requiring a search and a read; confirm one collapsed tool line per step and that expanding shows inputs and outputs. 6. Ask to run a command; confirm the approval card shows the exact command; allow it; confirm output appears including a non-zero exit. 7. Start a long turn and press Stop; confirm Stopping then an aborted turn. 8. Scroll up while streaming; confirm the viewport holds and Jump to latest appears. 9. Refresh; confirm the same conversation and full transcript return. 10. Create a second conversation, send a message, switch back and forth; confirm no content crosses. 11. Rename and archive; refresh; confirm both persisted. 12. Kill the server mid-turn, restart, reopen; confirm the interrupted turn reads as ended by restart and a new turn works. 13. Toggle developer mode; confirm records shown are the selected session's only. 14. Confirm no provider key appears anywhere in the DOM or in any network response.

---

## Risks / Trade-offs

### Hidden correctness risks, and what actually prevents each

| Risk | Prevented by | Proven by |
|---|---|---|
| Global records leaking into another conversation | One engine per session over one log (D3); no global record endpoint (D9); conversation-filtered events (D8); foreign-session rejection in the projector | Conversation-isolation and mixing tests; `?conversationId` filter test |
| Invented or renumbered durable sequences | `sequence?: never` on drafts; writer-assigned by `JsonlSessionLogWriter`; the projector refuses to append past a gap and never overwrites | Gap test; sequence-conflict test; contiguity assertion after restart |
| Duplicate assistant text after reconciliation | `stepId` on both paths (D12); key collision on `a:<stepId>` (D14); explicit supersession table | No-duplicate-text test; disconnect/reconnect golden-view comparison |
| A tool request losing its terminal result | Engine invariant 2; repair on open (D10); the projector shows an unterminated request as running rather than dropping it | Tool-pairing test; repair test; `reduceProviderHistory` issue-free after restart |
| Approval resolution arriving after cancellation | `ApprovalRegistry.cancelTurn` resolves pending approvals as denied; the server rejects a late resolve with `APPROVAL_NOT_PENDING`; the client maps that to the cancelled state rather than an error | Projector approval-after-cancel test; component test for the refusal path |
| A turn resurrecting after a terminal state | `updateTurn` raises `InvalidTransition` for a non-running turn; the projector never lets a later record change a terminal status | No-resurrection test |
| SSE disconnects creating gaps or duplicates | Amendment B resume, per session (D8); durable-only replay; `serverInstanceId` invalidation | Exactly-once-under-concurrent-appends test; golden-view comparison |
| In-memory persistence losing conversations on restart | `MemoryDurableSink` removed from the server path (D1) | Restart round-trip test |
| Browser-visible provider credentials | Key never leaves `cli.ts`; `baseUrlHost` only; headers stripped server-side | Assertion that no endpoint's response body contains the key |
| Debug state becoming canonical | Read-only drawer with no mutator access (D22) | Import-boundary test; toggling dev mode changes nothing |

### Trade-offs accepted

- **Duplicated `conversation.created` header per session log** (D2) → two lines per log, and a hard "never reduce across sessions" rule pinned by a test. The alternative broke single-log replay.
- **A conversation's sessions cannot be reduced together** (D2) → no whole-conversation `reduceEngineState`; debug state is per session. Acceptable: the engine never needed it, and provider history is session-scoped anyway.
- **`lastActivityAt` from mtime** (D4) → a state directory copied without preserving mtimes reorders the list. Cheap to fix later by adding an index op.
- **No virtualization** (D20) → very long conversations page rather than scroll continuously. Reversible; the item list is already the right shape.
- **Vitest in `apps/web`** → two test runners in the repo. Confined to the one package where `node --test` cannot work, and the projector — the part with real logic — stays on the repo convention.
- **`POST /commands` no longer returns a turn's records** (D7) → the client's optimistic user message is the only immediate feedback until SSE delivers `turn.started`. Acceptable, and it is what makes long turns survivable.
- **No in-app model switching** → changing the model means editing `.env.local` and restarting, after which the conversation continues in a new session with empty history, visibly. Correct for now: carrying history across a provider change is Milestone 5's problem.
- **Retry and continue links are ephemeral** → after a refresh they read as two ordinary user messages. A durable link would be a protocol change.
- **A token in the `/events` query string** (D23) → it would appear in a request log. There is no request log; noted so that adding one has to deal with it.
- **The server-side `stepId` and `shell` fixes touch `assistant-core`** (T0) → a milestone that is mostly client work edits the engine. Each is small, each is a defect against an existing written decision, and every one of them blocks a client-side correctness property.

### Dependency risks

- **S15: no system prompt and no AGENTS.md wiring.** The engine never tells the model who it is or what the project is. That is Milestone 3 close-out work, not this change, but it caps how good the T12 transcript can look. If the acceptance run produces a poor conversation, check this before suspecting the client.
- **T4C's conformance suite and retry are unfinished**, so a flaky provider stream surfaces as a failed turn. The client renders that correctly; it does not paper over it.
- **New frontend dependencies** — `react-markdown`, `remark-gfm`, `rehype-sanitize`, `shiki`. Shiki is the heavy one; the fixed language subset and lazy load (D17) are the mitigation, and a bundle-size budget in T5 is the check.

---

## Migration Plan

**Deploy.** There is no deployed state, so there is nothing to migrate. Today's server keeps everything in memory and today's client keeps nothing, so first run initializes a fresh state directory at version 1. The `storageVersion` mechanism exists from the start (D26) so that the *next* layout change has somewhere to land.

**Staging.** T0 through T2 are server-side and leave the existing client working — the old client breaks only when `GET /records` is removed, which happens in T2 alongside the client's switch to session-scoped replay. T3 onward is client work behind the same API. Each stage in `tasks.md` is independently reviewable and leaves `pnpm -r build`, `typecheck`, and `test` green.

**Rollback.** Per stage, by reverting the stage. The one-way step is the storage layout: a conversation written at version 1 is not readable by a build predating T1, which has no reader at all. Since there is no prior on-disk state, the rollback cost is losing conversations created after T1 — acceptable during implementation, and the reason `storageVersion` refuses to open a newer directory rather than guessing.

**Spec sync ordering.** `implement-web-client-harness` has requirements this change supersedes — global durable replay by sequence, and a first-class debug panel. Neither has graduated: `openspec list --specs` reports no accepted specs. So if that change is archived first, `openspec/specs/web-client-harness/spec.md` will be created carrying requirements that are already obsolete, and this change's deltas will not correct them because they target different capabilities. Two clean options, for Rishabh to pick (Open Question 3): archive the harness change *after* this one and let `conversation-store` be the accepted persistence and replay behaviour, or archive it first and add a MODIFIED delta here against the then-existing `web-client-harness` spec. Doing neither leaves two accepted specs disagreeing about `GET /records`.

---

## Open Questions

1. **Should `GET /records` keep working during implementation?** Removing it in T2 breaks the current client immediately; keeping it behind a deprecation flag until T4 keeps a working fallback for a few stages but also keeps the mixing bug reachable. Default if unanswered: remove it in T2, because a global record endpoint that still exists is a global record endpoint someone will call.

2. **Is the per-process token acceptable ergonomically?** It is required by D23's reasoning, and the cost is that `vite dev` needs `VITE_TURNTURN_TOKEN` from the CLI banner and that `curl`-ing the server by hand needs a header. If that friction is unwelcome the alternative is `Host`/`Origin` only, which leaves a local-process path to `shell` open — a real reduction in safety, not a preference. Default if unanswered: keep the token.

3. **Spec sync ordering**, as set out in the Migration Plan. This needs an answer before either change is archived, not before implementation starts.

4. **Is the exact provider-request diagnostic worth a public adapter API addition?** The normal chat UI does not need it, but it is useful when verifying the history and tools actually sent to LiteLLM or Ollama. A normalized `ProviderPort` request is not the wire JSON, and duplicating the adapter's request builder in the server would drift. An optional body-only observer on the exported adapter options is the smallest exact seam, but requires the full contract-altering design ritual and your review. Default if unanswered: do not add the hook or pretend an approximate body is exact; leave task 3.7 open and proceed only after deciding whether to defer this developer-only view.

Deliberately *not* left open, because each would change the specs or the task breakdown and is decided above: storage engine (D1), where `conversation.created` lives (D2), engine granularity (D3), who owns durable identity (D6), whether `POST /commands` awaits a turn (D7), Markdown renderer (D17), and whether to virtualize (D20).
