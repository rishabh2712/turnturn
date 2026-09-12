# Proposal: Coding Chat Workspace

Milestone 3.5. Scope and exit criteria live in `ROADMAP.md`; decisions in `design.md`; work in `tasks.md`.

## Why

`implement-web-client-harness` succeeded at what it set out to do: it proved the command/event contract survives a browser, and it gave us an operator surface for diagnosing the turn loop. It is an observability console, and the code says so — `apps/web/src/App.tsx` ships an "Initialize" button, a protocol timeline keyed by durable sequence, and a `<pre>` of `reduceEngineState` output beside the chat.

That harness cannot become the product by styling, because three of its foundations are wrong rather than plain:

- **Identity is minted in the browser.** `App.tsx:8-9` calls `id("conv")` / `id("sess")` on every page load, then paints the result of a *global* `GET /records` into it. Refresh the tab and the previous conversation's records render under a new conversation id. There is no conversation list to restore because there are no conversations — there is one process-wide record log.
- **Nothing is durable.** The only `DurableSink` is `MemoryDurableSink`, which lives in `assistant-core/src/testing.ts` and is wired into the production server at `runtime.ts:41`. Every conversation dies with the process, so "restore the conversation I was in" has nothing to restore from.
- **The renderer reads protocol records directly.** `chatFromRecords()` is a useful prototype and is now the ceiling: it has no session scoping, it keeps only the last assistant message per turn, it stops streaming after the first provider step, and it de-duplicates tool events by formatted title so two identical `read` calls collapse into one row. Each of those is a wrong answer to a question a projector has to answer properly.

Meanwhile the engine underneath is the part we trust: ports, the sequential turn loop, five policy outcomes, approval and cancellation races, six workspace tools, and a provider adapter, all under 63 passing tests. The gap is not the engine. The gap is that we have no product client, and the harness is structurally unable to become one.

Now, because the next milestones spend the engine's capability rather than extend it. Milestone 4's trust loop is approvals a human has to read; Milestone 5's compaction is invisible without a transcript; Milestone 6's diff preview needs somewhere to render a diff. Each of those is easier to design against a real client and guesswork without one. Doing this after Milestone 4 also means building the approval UI twice.

## What Changes

- **Durable per-session conversation storage.** Replace `MemoryDurableSink` in the server path with a file-backed sink built on the protocol package's existing `JsonlSessionLogWriter`: one JSONL log per session, sequences gapless within it. **BREAKING** for on-disk state: there is none today, so nothing migrates, but the layout gains a `storageVersion` and a migration mechanism from the start.
- **Deletes the forked provider-history reducer.** `assistant-core/src/session-provider-history.ts` is a 172-line fork of the protocol's `reduceProviderHistory` with the sequence check removed, existing only because the durable log is global while provider history is session-scoped. Per-session logs make sequences gapless, so the fork's trigger condition (recorded in `implement-sequential-agent-loop/tasks.md`, "Architectural Debt") is met and it goes.
- **A conversation lifecycle API.** List, create, open, activate, rename, archive, and delete conversations; session-scoped record retrieval replacing the global `GET /records`; conversation-filtered SSE replacing the broadcast-to-everyone live stream.
- **Server-owned durable identity.** The browser stops minting `conv_`/`sess_` ids and stops sending `conversation.create` / `session.create`. It asks the server to activate a conversation and gets ids back. Client-originated commands narrow to `turn.submit`, `turn.cancel`, `approval.resolve`.
- **Interrupted-turn repair.** A turn that was running when the process died is finalized on next open with durable terminal records, rather than rendering as a spinner that never stops.
- **A conversation projector as a real component.** A new framework-free `packages/chat-client` holding the view model, the projector, the durable/live reconciliation, the transport interface, and the client store — unit-tested with `node --test` like every other package, and reusable from Electron. `chatFromRecords()` is retired.
- **The product shell.** Sidebar with workspaces and conversations, a header carrying title/workspace/model/status, a continuous transcript, and a composer fixed near the bottom.
- **Rich rendering.** Markdown, syntax-highlighted code blocks with copy, tables, lists, clickable workspace file references, and streaming without duplicated text.
- **Grouped tool activity.** One expandable card per provider step instead of one row per protocol event, with per-tool presentation for read, write, edit, glob, grep, and shell.
- **Inline approvals, stop, retry, and continue**, plus explicit reconnecting / waiting-for-approval / executing / generating states.
- **Developer mode.** Everything currently on screen by default — timeline, raw records, live events, reducer issues, provider request — moves behind an explicit drawer that can read the store but not write to it.
- **Localhost hardening.** `Host` and `Origin` validation plus a startup-generated session token on state-changing requests. Not gold-plating: `shell` is a reachable tool with no sandbox until Milestone 4, so today any web page the user visits can drive it via DNS rebinding.

## Capabilities

### New Capabilities
- `conversation-store`: durable per-conversation, per-session record persistence; conversation listing and lifecycle; session-scoped replay; restart repair of interrupted turns; storage versioning and migration; the conversation-scoped HTTP surface and its localhost security boundary.
- `coding-chat-workspace`: the product client — conversation projection into a normalized view model, durable/live reconciliation, application shell and navigation, Markdown and code rendering, grouped tool activity, composer and turn controls, approval and error recovery, and developer mode.

### Modified Capabilities

None. `openspec list --specs` reports no accepted specs: `openspec/specs/` is empty because Milestone 3's behavior has not graduated yet. The requirements this change supersedes — global durable replay and an always-visible debug panel — live in the in-flight `implement-web-client-harness/specs/web-client-harness/spec.md` delta, not in a main spec, so there is nothing to write a MODIFIED delta against. `design.md` records which of those requirements this change replaces and the sync ordering that follows.

## Impact

**Engine and protocol.** `packages/protocol` is untouched; it is frozen, and this change needs nothing from it that is not already there. `packages/assistant-core` changes in four narrow places: `stepId` is carried on assistant-message records and content-delta events so live text can be paired with its durable message; `shell` returns a non-zero exit as a `completed` outcome carrying stdout and stderr rather than discarding both; the OpenAI chat-completions history translator stops emitting a `tool_call_id` that disagrees with the `id` it put on the assistant message; and `session-provider-history.ts` is deleted. The turn loop, ports, policy handling, tool wave runner, and approval registry are not redesigned.

**Server.** `packages/assistant-server` takes the largest refactor: one engine per session behind a runtime registry, a file-backed session sink, a conversation store, the `/api` surface, conversation-filtered broadcasting, and request validation. This also fixes three existing defects it inherits — a global record slice in command outcomes, a single global append chain that serializes unrelated conversations, and idempotency keyed globally rather than per conversation.

**Client.** `apps/web/src/state.ts`, `protocol.ts`, `App.tsx`, and `styles.css` are replaced rather than extended. The React app keeps its rule of never importing `assistant-core`.

**Dependencies.** New in `apps/web` only: `react-markdown`, `remark-gfm`, `rehype-sanitize`, `shiki`, and a browser-capable test runner, since `node --test` has no DOM. `packages/chat-client` adds no runtime dependency beyond `@turnturn/protocol`.

**Not in this change.** Queued turns, per-tool cancel (`tool.cancel` is still `UNIMPLEMENTED` in the engine), in-app model or workspace switching, multi-workspace, conversation search, attachments, diff preview beyond what tool output already carries, compaction display, and any Electron packaging. Electron is a design constraint here — the transport is an interface with an HTTP implementation — not a deliverable.

**Dependencies on prior work.** This change assumes the engine boundary from `implement-sequential-agent-loop` (Decisions 1–12 and behavioral contracts B1–B18) and the transport shape from `implement-web-client-harness` (Decisions 2, 3, 8, 9 and Amendments A–C). It does not reopen them. It does complete two of that change's unfinished items, because they are load-bearing here: the Amendment B resume test under concurrent appends, and a live provider turn driven end to end from the client.
