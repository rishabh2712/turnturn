# Tasks: Coding Chat Workspace

Decisions are in `design.md` and are not repeated here — a task that cites `D7` means read Decision 7. Requirements are in `specs/`. Scope is in `ROADMAP.md`. Read all three before starting.

## Working Conventions

Copied from `packages/protocol` and `implement-sequential-agent-loop/tasks.md`. They are not obvious and they will bite.

- **ESM only.** `"type": "module"`, `NodeNext` resolution — relative imports need a `.js` extension even in TypeScript source. `apps/web` is the exception; it is bundler-resolved.
- **tsconfig mirrors `packages/protocol/tsconfig.json`** for new packages: `ES2022`, `strict`, `declaration`, `outDir: dist`, `rootDir: src`, plus `noUncheckedIndexedAccess` (every index access is `T | undefined`) and `exactOptionalPropertyTypes` (omit the key, never assign `undefined`).
- **Tests are `node --test` on `.mjs` against built output**, for every package including the new `packages/chat-client`. `apps/web` is the one exception and uses `vitest` + `happy-dom`, because `node --test` has no DOM — see `design.md`, Testing Strategy.
- **`serializeJson` is far stricter than `JSON.stringify`.** It rejects `undefined`, `-0`, non-finite numbers, symbols, functions, bigints, sparse arrays, accessor and non-enumerable properties, cycles, and any object whose prototype is not `Object.prototype` or `null`. Build payloads as plain object literals.
- **`sequence` is writer-assigned.** Emit `DurableRecordDraft` (typed `sequence?: never`); the sink returns a real sequence. Never invent, filter, or renumber one.
- **Branded ids come back from `JSON.parse` as plain strings.** Re-brand through `parseId`, never cast.
- **No edits to `packages/protocol`.** It is frozen. If something seems to need one, it does not — check `ScopeFields` first (see D12).
- **Narrow facades, never `export *`.** `packages/chat-client/src/index.ts` exports the store, the transport interface, the HTTP transport, the view-model types, and the projector entry point. Nothing else. Tests deep-import internals; that is normal and keeps the surface intentional.
- **The browser must not import `assistant-core`.** `@turnturn/protocol` root entry is allowed (pure, no `node:` imports); `@turnturn/protocol/session-log` is not (it imports `node:fs`).

### Definition of done, every stage

`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, and `pnpm lint` pass. New behaviour has a test that fails without it. Every test that produces records asserts `reduceEngineState(records).issues` is empty. No new dependency without a stated reason. The stage is independently reviewable: it leaves the tree working, not half-migrated.

## Design Gate

- [x] Design review by the user. Rishabh asked to start after the defaults were proposed: keep the global `/records` route removed, keep the local token, decide spec archive order later, and defer exact provider-request diagnostics.

## Implementation Tasks

### 1. T0 — Correctness prerequisites

Five defects in `assistant-core`, each blocking a client-side correctness property, plus the repo hygiene that makes the rest of the work measurable. Doing these first is not tidiness: S12 makes the T13 acceptance proof impossible, and S10 makes "no duplicate assistant text" unprovable.

Files: `assistant-core/src/provider-step-runner.ts`, `records.ts`, `workspace/shell-tool.ts`, `providers/openai-chat-completions/history.ts`, `engine.ts`, `test/providers/openai-chat-completions/history.test.mjs`, `test/engine.test.mjs`, `test/workspace-tools.test.mjs`, `apps/web/package.json`, `apps/web/vite.config.ts`.

Depends on: nothing.

- [x] 1.1 Write a failing history test first: one step, two tool calls with provider ids, both results, replayed — assert every `tool` message's `tool_call_id` equals the `id` of its entry in the preceding assistant message's `tool_calls`. Then fix `history.ts` to emit `providerToolCallId ?? toolCallId` on **both** sides (S12). Update the existing assertions at `history.test.mjs:26-27,46` — they currently pin the bug, so changing them is the point, not a regression.
- [x] 1.2 Carry `stepId` on assistant text (D12, S10): pass `{ ...command, stepId }` to `contentDelta`, `reasoningDelta`, and `assistantMessageCompleted` in `provider-step-runner.ts`, and widen those `RecordEmitter` scope types to accept it. Verify with a test asserting the `assistant.message.completed` record and the `content.delta` events of a two-step turn each carry their own step's `stepId`, and that `reduceEngineState(records).issues` is still empty.
- [x] 1.3 Make a non-zero shell exit a `completed` outcome carrying `{ stdout, stderr, exitCode, stdoutTruncated, stderrTruncated }` (S11), per loop design Decision 4. Keep `SHELL_SPAWN_FAILED`, `SHELL_TIMEOUT`, and `SHELL_ABORTED` as `failed`. Verify by extending `workspace-tools.test.mjs` to assert a command exiting 1 returns `completed` with the exit code and with stderr preserved — the existing test asserts the opposite and must be updated.
- [x] 1.4 Key idempotency by `(conversationId, idempotencyKey)` and reject a replay whose `type` differs with a distinct conflict code (S4, B7). Verify with tests for: same key same type returns `duplicate` with the original records; same key different type returns `rejected`; a rejected command does not consume its key.
- [x] 1.5 Add `apps/web/vite.config.ts` proxying `/api`, `/commands`, and `/events` to `127.0.0.1:8787` (C8), and replace the empty-glob `test` script with `vitest run` (C9). Verify `pnpm --filter @turnturn/web dev` serves a page that can reach the server, and that `pnpm --filter @turnturn/web test` fails loudly rather than passing with zero tests.
- [x] 1.6 Delete the `x-turnturn-last-sequence` header from the SSE response (S6) and tidy the `req.on("close", () => cleanup())` reference that precedes `cleanup`'s declaration in `http-server.ts`. Verify the existing SSE test still passes and add an assertion that the header is absent.

Acceptance: `pnpm -r test` green with the three rewritten assertions; a two-step scripted turn produces per-step `stepId` on both durable and live assistant text; a `false`-like shell command yields a completed outcome with output.

### 2. T1 — Conversation and session persistence

The file-backed store, with no API and no client changes. The old in-memory path keeps working until stage 3 so this stage is reviewable on its own.

Files: new `assistant-server/src/storage/{state-dir,conversation-index,conversation-store,session-sink}.ts`; `assistant-server/src/session-runtime.ts`; `assistant-core/src/records.ts` (add `seedSessionRecords`); delete `assistant-core/src/session-provider-history.ts`; `assistant-core/src/provider-step-runner.ts`; new `assistant-server/test/storage-*.test.mjs`.

Depends on: stage 1.

- [x] 2.1 Write the layout tests first, against the directory shape in `design.md` "Server persistence layout": fresh init writes `meta.json` at version 1; a directory recording a higher version refuses to start naming both versions and reads nothing; a second process refuses the `.lock` naming the holder. Then implement `state-dir.ts`.
- [x] 2.2 Implement `conversation-index.ts` (D4): append `created` / `titled` / `archived` / `unarchived` / `deleted`, fold in file order with last-wins per id, compact by atomic `rename` above 5,000 lines, and rebuild from `conversation.json` files plus session-log headers when the index is missing or unparseable. Verify with tests for fold order, compaction idempotence, rebuild-without-touching-logs, and `lastActivityAt` derived from session-file mtime.
- [x] 2.3 Implement `session-sink.ts` as a `DurableSink` over `JsonlSessionLogWriter` (D1): one log per session, `conversation.created` then `session.created` as sequence 1 and 2 (D2), `records()` returning that session's records only. Verify a round-trip test: append a scripted turn, reopen the log, assert records are byte-identical, sequences contiguous from 1, and both `reduceEngineState` and `reduceProviderHistory` report no issues.
- [x] 2.4 Add torn-tail recovery to the sink (D11, S13): on `recoveredCorruptTail`, copy to `<name>.corrupt-<iso>`, truncate to the last valid record, open at `nextSequence`. On corruption that is not at the tail, report unopenable and modify nothing. Verify both paths with hand-written logs, and assert other conversations stay usable in the second case.
- [x] 2.5 Implement interrupted-turn repair on open (D10): under the append lock, before serving, append a terminal result per requested-but-unterminated tool call, a `provider.step.failed` per running step, then `turn.aborted`, all coded `SERVER_RESTARTED` with `synthetic: true` on the tool results. Verify with a hand-written log ending mid-turn: exact records appended in that order, `issues === []`, and a second open appending nothing.
- [x] 2.6 Implement `conversation-store.ts`: create, open, rename, archive, unarchive, delete-only-if-archived, and session activation comparing recorded provider and model against current config (D6). Verify with tests for each, plus title derivation from the first user message capped at 60 characters and a manual rename that derivation does not overwrite (D24).
- [x] 2.7 Implement `SessionRuntime` and `SessionRuntimeRegistry` (D3): one engine per session, shared provider/tools/policy/ids/clock, lazy open, LRU cap of 8, never evict a runtime with a running turn or pending approval, close idle after 10 minutes. Verify that two sessions append concurrently without interleaving sequences and that a command outcome contains only its own session's records (S1, S3).
- [x] 2.8 Add `RecordEmitter.seedSessionRecords(sessionId, records)` and call it after hydration so provider history includes prior turns. Then **delete `session-provider-history.ts`** and point `provider-step-runner.ts` at the protocol's `reduceProviderHistory`. Verify the existing engine tests stay green and that a hydrated session's second turn sends the earlier turns to the provider.
- [x] 2.9 Verification task: restart round-trip at scale. Create 200 conversations with 500 records each, restart, and assert listing latency stays flat and no listing reads a record payload (D4). A scan-based implementation fails this on timing alone.

Acceptance: `session-provider-history.ts` is gone and the debt note in `implement-sequential-agent-loop/tasks.md` can be checked off; conversations survive restart with both reducers clean; an interrupted turn is finalized exactly once; a torn tail recovers.

### 3. T2 — Conversation-scoped server API

Files: `assistant-server/src/http-server.ts`, new `assistant-server/src/api/*.ts`, `security.ts`, `runtime.ts`, `live-broadcaster.ts`, `cli.ts`, `assistant-server/test/{api,security,events}-*.test.mjs`.

Depends on: stage 2.

- [x] 3.1 Write the security tests first (D23, S9): a request whose `Origin` differs is refused and reaches no engine; a request whose `Host` is neither loopback nor `localhost` with the port is refused; a `POST /commands` without `X-Turnturn-Token` is refused and executes no tool; no response ever carries `Access-Control-Allow-Origin`. Then implement `security.ts` and apply it to every route.
- [x] 3.2 Generate a 256-bit token at startup, print it in the CLI banner, and inject `<script>window.__TURNTURN__={token:"…"}</script>` into `index.html` when the server serves it. Verify the served HTML contains the token and that the built client reads it; document `VITE_TURNTURN_TOKEN` for the `vite dev` path.
- [x] 3.3 Implement the conversation routes from `design.md` "API surface": list, create, get, activate, patch, delete. Verify one test per route including `409 CONVERSATION_NOT_ARCHIVED` on deleting an unarchived conversation.
- [x] 3.4 Implement `GET /api/conversations/:cid/sessions/:sid/records` and **remove `GET /records`** (D9, S5). Verify contiguous ascending records above `afterSequence`, and `404 SESSION_NOT_IN_CONVERSATION` for a session that belongs to another conversation. Resolve Open Question 1 before doing the removal.
- [x] 3.5 Add a conversation filter to `LiveBroadcaster` (D8, S7) and require `?conversationId` on `/events`. Extend the snapshot frame to `{ conversationId, serverInstanceId, sessions: [{ sessionId, lastSequence }] }`. Verify that a subscriber for A receives none of B's events, that the frame carries a cursor per session, and — keeping the existing assertions — that no `id:` field is ever emitted and a non-reading subscriber cannot stall a turn.
- [x] 3.6 Make `POST /commands` return `202 { kind:"accepted", turnId }` for `turn.submit` without awaiting the turn, holding the promise in a per-session in-flight map for duplicate-submit reuse and graceful shutdown (D7). Keep `turn.cancel` awaited. Verify that the POST resolves while the turn is still running and that the turn still reaches a terminal record. Existing `api-conversations.test.mjs` proves acceptance before completion, duplicate reuse, and later terminal replay.
- [x] 3.7 Implement `GET /api/runtime` with `baseUrlHost` instead of `baseUrl` (S8), `GET /api/workspaces/:key/file` confined through `WorkspacePathGuard` with text-only and size caps (D19), and session-scoped `/api/debug/state` (D22). Tests cover path escape, non-text and oversized refusals, and absence of the configured API key in responses. Exact provider-request inspection is deferred by resolved Open Question 4; no approximate endpoint is exposed.
- [x] 3.8 Verification task: the Amendment B resume race, per session. Open `/events`, append records concurrently from two sessions, run the snapshot-then-replay algorithm, and assert **every record is observed exactly once** — no gap, no duplicate. `events-resume.test.mjs` also forces a publish while the snapshot cursor is collected; that test failed before registration was moved ahead of cursor collection.

Acceptance: no endpoint returns records spanning conversations; no live event crosses conversations; unauthenticated and cross-origin requests are refused; the resume race test passes under concurrent appends.

### 4. T3 — Client conversation projector

Pure logic, no React, no DOM. This stage produces no visible change and is the foundation for every stage after it.

Files: new `packages/chat-client/` with `package.json`, `tsconfig.json`, `src/{index,view-model,projector,tool-summary,reconcile,store,transport,http-transport,resume}.ts`, `test/*.test.mjs`.

Depends on: stage 3 (for the transport implementation; the projector itself depends only on stage 1).

- [x] 4.1 Scaffold `packages/chat-client` to protocol conventions, depending only on `@turnturn/protocol`. `browser-boundary.test.mjs` verifies that `dist` contains the entry point and declarations, and that its built output references neither `node:` builtins nor `assistant-core` (D13).
- [x] 4.2 Define `view-model.ts` from `design.md` "Conversation projection" — the six item kinds, `ToolCallView`, `ToolCallDetail`, `ConversationView`, `TurnPhase`. `view-model.type-tests.ts` switches over all six kinds and fails typechecking if a new kind is added without handling it.
- [x] 4.3 Write the projector tests before the projector. One test per invariant in `design.md` "Projector invariants worth testing": session isolation, conversation isolation, no duplicate assistant text, multi-step ordering, exactly-one-terminal-per-request, wave grouping by `stepId`, approval lifecycle, approval-after-cancellation, no turn resurrection, sequence gap, redelivery idempotence, order stability, optimistic supersession, cancellation metadata, `synthetic` distinction, phase derivation. Build the fixtures as real record arrays so they stay honest.
- [x] 4.4 Implement `reconcile.ts` — the supersession table and the two retention rules from `design.md` "Durable ↔ live reconciliation", including the `live-text-unbacked` diagnostic. Verify the table row by row and verify that dropping unbacked non-empty text raises the diagnostic rather than silently losing words.
- [x] 4.5 Implement `projector.ts`: per-session projection, concatenation by session ordinal, stable keys, total order key. Verify all of 4.3 passes, and add the D2 guard — reducing two session logs jointly reports issues, so the never-cross-sessions constraint is executable.
- [ ] 4.6 Implement `tool-summary.ts`: per-tool headline and `ToolCallDetail` for `read`, `write`, `edit`, `glob`, `grep`, `shell`, plus the `json` fallback, and the group summary algorithm. Verify table-driven, one row per tool per status, including the 90-character cap, the truncation markers, an unknown tool name, and a non-zero shell exit rendering as a warning with output rather than as a failure.
- [ ] 4.7 Implement `store.ts` with a `useSyncExternalStore`-compatible `subscribe`/`getSnapshot`, holding `Map<SessionId, SessionSlice>`, conversation metadata, and connection state. Verify that ingesting the same record twice leaves the snapshot deep-equal and that a foreign-session record is rejected with a diagnostic.
- [ ] 4.8 Define `transport.ts` (`ChatTransport`) and implement `http-transport.ts` plus `resume.ts` (D21, D8). Verify against a real local `assistant-server`: snapshot-then-replay per session, `serverInstanceId` change forcing a full refetch and clearing live state, and the golden test — disconnect mid-turn, reconnect after it completes, and assert the projected view is identical to that of a client that never disconnected.

Acceptance: every projector invariant has a test that fails without its implementation; the golden reconnect comparison passes; the package builds to a browser-safe bundle.

### 5. T4 — Application shell and navigation

The first visible change. The debug surface goes away here rather than in stage 10, because leaving it in place means designing two layouts.

Files: replace `apps/web/src/App.tsx`; new `apps/web/src/{main.tsx, providers/*, components/shell/*}`, `apps/web/src/styles/*`; delete `apps/web/src/state.ts` and `apps/web/src/protocol.ts`; `apps/web/package.json`; `apps/web/test/*`.

Depends on: stage 4.

- [ ] 5.1 Add `vitest`, `happy-dom`, and `@testing-library/react` to `apps/web` and land one real test so the suite is no longer vacuous. Verify `pnpm --filter @turnturn/web test` runs it.
- [ ] 5.2 Delete `state.ts` and `protocol.ts` (C3–C7, C11) and rewrite `App.tsx` around `TransportProvider`, `RuntimeProvider`, and `ConversationListProvider`. Verify no module under `apps/web/src` declares a protocol type and no component reads a record or event directly.
- [ ] 5.3 Build the sidebar: workspace group header, New conversation, conversation list ordered by last activity, per-row rename and archive, archived section. Verify component tests for create, rename, archive, and switch, driven through a fake `ChatTransport`.
- [ ] 5.4 Build the header: inline-editable title, workspace chip, model chip, phase and connection summary, actions menu, and the read-only configuration popover showing workspace path, provider, model, and tool catalog with no credential (D22, spec "Configuration is visible without being editable"). Verify the popover contains no key and states that configuration is server-owned.
- [ ] 5.5 Implement URL and local state: `/c/:conversationId` plus `?dev=1` in the URL, and last-conversation-id, per-conversation draft, sidebar collapse, and dev preference in `localStorage`. Verify selection restoration across a reload, the bare-`/` fallback chain, and that a draft survives switching away and back.
- [ ] 5.6 Implement the empty, loading, disconnected, unopenable, and first-run states from `design.md` "Empty, loading, and failure states". Verify one test per state, including that the sidebar stays usable when a conversation cannot be opened.
- [ ] 5.7 Implement responsive behaviour at the three breakpoints. Verify the sidebar collapses to an overlay below 1100px and that the composer respects `env(safe-area-inset-bottom)` below 768px.
- [ ] 5.8 Verification task: the conversation-mixing test. Mount the real `AppShell` against a fake transport serving two conversations whose sessions both number 1..20, and assert A shows only A, B shows only B, switching back shows no crossover, and a live event for B while A is displayed appears nowhere.

Acceptance: the default UI shows no timeline, no raw JSON, no sequence numbers, and no Initialize button; selection survives a reload; no content crosses conversations.

### 6. T5 — Rich message rendering

Files: new `apps/web/src/components/markdown/*`, `apps/web/src/components/message/*`, `apps/web/index.html` (CSP), `apps/web/package.json`.

Depends on: stage 5.

- [ ] 6.1 Write the containment tests first (D17, D18, security): a `<script>` in assistant text does not execute and is not interpreted; an element with an inline event handler is stripped; a `javascript:` link renders as plain text; an image renders as a link, not an `<img>`; an external link carries `rel="noopener noreferrer nofollow"`.
- [ ] 6.2 Add `react-markdown`, `remark-gfm`, `rehype-sanitize`, and `shiki`, and build the Markdown pipeline with the restrictive sanitize schema and the scheme allowlist. Verify headings, lists, tables, blockquotes, and inline code render, and that 6.1 passes.
- [ ] 6.3 Add the Shiki `code` renderer: lazily loaded, fixed language subset, copy button carrying the block's exact source, and unhighlighted fallback above 2,000 lines or 100 KB or for an unknown language. Verify highlighting appears after load, that copy yields the original text, and that an oversized block renders as plain text rather than failing.
- [ ] 6.4 Handle streaming Markdown: auto-close an unterminated fence for display only, skip highlighting until the block closes, memoize on the text prefix. Verify a message ending mid-fence renders without error and keeps its text visible.
- [ ] 6.5 Add the content-hash LRU for parsed output and the cheap has-Markdown pre-check. Verify the cache is hit on re-render of unchanged content and bounded at its cap.
- [ ] 6.6 Implement file references (D19): the `remark-workspace-paths` plugin over text nodes only, the `turnturn://file/…` anchor with `data-workspace-path`/`data-line`, the `FileReferenceProvider` with an injected `openFile`, and the in-app peek fed by `GET /api/workspaces/:key/file`. Verify a path with a line number becomes a reference, a path inside inline or fenced code does not, activation calls the injected handler instead of navigating, and the peek shows the referenced region.
- [ ] 6.7 Add the strict `Content-Security-Policy` to the built `index.html` and a bundle-size budget check for the Shiki subset. Verify the built app loads under the CSP and that the budget fails the build when exceeded.

Acceptance: assistant messages render as a readable document with highlighted code, tables, and clickable file references; no model-supplied HTML, script, image, or dangerous scheme reaches the DOM.

### 7. T6 — Grouped tool activity

Files: new `apps/web/src/components/tool/*`; `apps/web/test/tool-*.test.tsx`.

Depends on: stages 4 and 6.

- [ ] 7.1 Build `ToolActivityCard`: collapsed one-line summary with a status glyph, native disclosure semantics, and expansion revealing each call in `providerOrder`. Verify a three-tool step renders one collapsed line and three rows when expanded, and that two identical `read` calls both appear (C5).
- [ ] 7.2 Build the per-presentation detail views for all seven `ToolCallDetail` variants. Verify one test each: `file-read` shows path and line range; `file-edit` shows a before/after diff from `oldText`/`newText`; `search` shows path, line number, and matched line; `paths` shows the match list and truncation; `shell` shows command, cwd, exit code, stdout, and stderr; `file-write` shows bytes; `json` falls back readably.
- [ ] 7.3 Implement output bounding: per-presentation caps, head-biased for reads and searches and tail-biased for shell, an explicit omission marker, a "Show all" control, and a hard cap above which only "Copy raw" is offered. Verify a 50,000-line result does not render 50,000 nodes and that a tool-reported `truncated` flag is shown distinctly from a UI cap.
- [ ] 7.4 Render tool output as literal text in `<pre>` with ANSI stripped, never through the Markdown pipeline (D18). Verify that a tool result containing Markdown and HTML renders as visible literal text.
- [ ] 7.5 Show the non-terminal and engine-produced states: a requested call with no result as running with live `tool.progress` and streamed stdout, a `synthetic` result distinguished from a real tool error, and `cancellation.requested` as completed-after-cancel rather than as a failure. Verify one test each.

Acceptance: a tool-using turn reads as one collapsed line per step; every lifecycle fact remains reachable by expanding; nothing is lost to de-duplication or truncation without saying so.

### 8. T7 — Composer and turn controls

Files: new `apps/web/src/components/composer/*`; `apps/web/src/components/viewport/*`; `apps/web/test/composer-*.test.tsx`.

Depends on: stage 5.

- [ ] 8.1 Build the composer: auto-growing textarea, phase line, workspace and model footer, and the Send control. Verify `Enter` sends, `Shift+Enter` inserts a newline, `Cmd/Ctrl+Enter` always sends, and the optimistic user message appears immediately and is superseded by its durable record without duplication.
- [ ] 8.2 Replace Send with Stop while a turn is running (D7 interaction detail). Verify Stop submits `turn.cancel`, shows `Stopping…`, keeps the turn displayed as running until its terminal durable record arrives, and never shows a terminal state before that record exists.
- [ ] 8.3 Make `Enter` while a turn is running a no-op that states the reason and preserves the text. Verify no second turn is submitted and the draft survives.
- [ ] 8.4 Implement Retry and Continue: Retry only when `error.retryable`, both submitting a new turn with a fresh `turnId`, neither reopening a terminal turn. Verify a retryable failure offers Retry and a fatal one does not, and that Continue appears on `output-limit` and on abort.
- [ ] 8.5 Implement scroll behaviour: pinned within 48px of the bottom, unpin on user scroll, "Jump to latest" with an arrived-since count, click to scroll and re-pin, and never move the viewport while unpinned. Verify on the pinned/unpinned state and the count rather than on pixels — `happy-dom` has no layout, and the test should say so.
- [ ] 8.6 Implement the keyboard map: `Escape` cancels a running turn and otherwise closes an overlay, `Cmd/Ctrl+K` focuses the composer, `Cmd/Ctrl+Shift+D` toggles developer mode. Verify each, and verify `Escape` never resolves an approval.

Acceptance: send, stop, retry, and continue all work; streaming does not move a viewport the reader has scrolled; the composer never silently swallows input.

### 9. T8 — Approvals, errors, and recovery

Files: new `apps/web/src/components/approval/*`, `apps/web/src/components/status/*`; `apps/web/test/approval-*.test.tsx`.

Depends on: stages 7 and 8.

- [ ] 9.1 Build the inline approval card at the transcript position where the approval was requested (D16). Verify the shell command renders verbatim as literal text and unparsed, the working directory is shown, and both Allow and Deny are offered.
- [ ] 9.2 Implement resolution: submit `approval.resolve`, disable both choices while in flight, and make a second submission impossible. Verify the dispatched command's decision and scope, and that the card shows `Resolving…`.
- [ ] 9.3 Implement the cancelled path: a turn cancelled before the user answers shows the approval as cancelled with the turn still terminal, and a late resolve refused with `APPROVAL_NOT_PENDING` renders as that same cancelled state rather than an error (C6). Verify both.
- [ ] 9.4 Build the off-screen approval banner. Verify it appears only when a pending approval is outside the viewport and that activating it moves the viewport to the card.
- [ ] 9.5 Implement the error and recovery table from `design.md` "Error and recovery behaviour". Verify one test per row, including a rejected command resyncing from the server rather than leaving stale local state.
- [ ] 9.6 Implement connection states: reconnecting on `EventSource` error with the transcript readable and Send unavailable, and a `serverInstanceId` change clearing live state and refetching. Verify both, and verify the restart case renders as a session divider plus an aborted turn rather than a modal.

Acceptance: an approval can be answered without losing the context that produced it; every failure has a stated cause and, where one exists, a recovery; a restart mid-turn is legible.

### 10. T9 — Developer-mode drawer

Files: new `apps/web/src/components/developer/*`; `apps/web/test/developer-*.test.tsx`.

Depends on: stages 5 and 9.

- [ ] 10.1 Build the drawer with the contents listed in D22, reading through read-only selectors only. Verify it shows the selected session's records and no other session's.
- [ ] 10.2 Enforce the boundary: verify with a test that no module under `components/developer/` imports a store mutator, and that toggling developer mode leaves the transcript, turn state, and conversation list unchanged (law 8).
- [ ] 10.3 Add the copy-as-JSON bug bundle from available read-only state. Verify the bundle contains no configured API key. Exact provider-request inspection is deferred beyond this milestone.

Acceptance: every diagnostic the harness showed by default is reachable on demand; none of it can drive the application.

### 11. T10 — Electron-ready transport abstraction

No Electron app is built here. This stage proves the seam is real rather than aspirational.

Files: `packages/chat-client/src/transport.ts`; `apps/web/src/providers/TransportProvider.tsx`; `packages/chat-client/test/transport-contract.test.mjs`.

Depends on: stages 4 and 9.

- [ ] 11.1 Extract a transport contract test parameterised over an implementation, and run it against both `HttpChatTransport` and an in-memory fake. Verify listing, lifecycle, replay, live subscription, and command submission all pass for both.
- [ ] 11.2 Verify the substitution property end to end: construct the app with the fake transport and assert the full UI works — this is the same wiring an `IpcChatTransport` would use, and it is what makes the Electron claim checkable.
- [ ] 11.3 Verify no view component imports `HttpChatTransport` and that `openFile` is injected rather than imported, so the two host-specific behaviours are both parameters (D19, D21).

Acceptance: the client works against a transport that is not HTTP, with no component changes.

### 12. T11 — Automated test completion

Most tests are written inside their own stage, test-first. This stage closes the gaps that span stages and are easy to leave undone.

Files: `apps/web/test/*`, `packages/chat-client/test/*`, `assistant-server/test/*`, `package.json`.

Depends on: stages 1–11.

- [ ] 12.1 Add the accessibility suite: axe-core with no violations on the shell, keyboard traversal across list, header, transcript, tool expansion, approval choices and composer, `aria-live="polite"` on the streaming region and phase, `aria-expanded` on tool cards, accessible names on every icon-only control, visible focus, and `prefers-reduced-motion` honoured.
- [ ] 12.2 Add the credential-leak assertion as a suite-level test across every endpoint: no response body contains the configured API key, and none contains the full provider base URL.
- [ ] 12.3 Wire `pnpm -r test` to include `chat-client` and `apps/web`, and verify a deliberately broken projector invariant fails the root command — a green suite that does not cover the client is what C9 was.
- [ ] 12.4 Verification task: review the invariant list in `design.md` "Projector invariants worth testing" and the risk table in "Risks / Trade-offs" against the suite, and confirm every row has a test that fails without its mechanism. Record any row that does not.
- [ ] 12.5 Add `scripts/check-no-protocol-duplication.mjs` (design.md "No-duplicate-contract guard") and wire it into root `pnpm check`. It fails if any `.ts`/`.tsx` outside `packages/protocol` declares a type or interface named `CommandEnvelope`, `DurableRecord`, `LiveEvent`, or `CommandOutcome`, and fails if `apps/web/package.json` omits `@turnturn/protocol` as a dependency. Verify it fails against a deliberately reintroduced copy of C7's `protocol.ts`, then remove that copy.

Acceptance: `pnpm -r test` covers projector, components, transport, and persistence; every named correctness risk has an executable counter-test; `pnpm check` fails if the client protocol duplication (C7) is ever reintroduced.

### 13. T12 — Live LiteLLM acceptance proof

Files: new `scripts/acceptance-chat.mjs`; `openspec/changes/implement-coding-chat-workspace/research/acceptance-run.md`; `ROADMAP.md`.

Depends on: stage 12.

- [ ] 13.1 Write `scripts/acceptance-chat.mjs`, excluded from the default run and gated on `TURNTURN_ACCEPTANCE=1`, driving the real server over HTTP exactly as the browser does: activate, submit "Find where ToolExecutorPort is defined, then read that file and summarise it", answer any approval, wait for `turn.completed`.
- [ ] 13.2 Assert in the script: at least two provider steps, at least one tool with a terminal result, `reduceEngineState` and `reduceProviderHistory` both issue-free, a non-empty final assistant message, and a projected view containing at least one tool-activity group and one assistant message.
- [ ] 13.3 Restart the server inside the run and assert the projected view is unchanged, so persistence is proven by the same test that proves the turn.
- [ ] 13.4 Run the same prompt manually through the browser and walk the 14-step manual acceptance flow in `design.md`. Record the outcome, including any defect found, in `research/acceptance-run.md` — a finding that lives only in a chat log evaporates.
- [ ] 13.5 Update `ROADMAP.md` Milestone 3.5 status in this same change, per `openspec/project.md`. Verify `pnpm check:milestone implement-coding-chat-workspace` passes.

Acceptance: a real model, through LiteLLM, uses a tool and answers in the product UI; the conversation survives a restart; the run is recorded.

## Gotchas

Collected because each one has already cost time somewhere in this repo or is one edit away from doing so.

- **`reduceEngineState` reports `out_of_order` on any sequence gap.** If you filter, reorder, or merge records anywhere, it will tell you. Listen to it rather than working around it — that is how the forked reducer happened (walkthrough, scar #3).
- **Never reduce two session logs together** (D2). Each starts with its own `conversation.created`, so a joint reduction reports `duplicate_entity`, correctly. Stage 4.5 pins this with a test; do not "fix" that test.
- **Live events have no `sequence`.** `LiveEvent.sequence` is typed `never` on purpose. Resume is by durable record sequence only. Leave the trap armed.
- **Do not add `id:` to the SSE stream.** `EventSource` auto-resends `Last-Event-ID`, which would promise replay on a channel that drops deltas by design (harness Amendment A).
- **`exactOptionalPropertyTypes` means omit the key.** `{ stepId: undefined }` is a type error; spread a conditional object instead. Every record builder in `records.ts` already does this with `optionalField`.
- **`serializeJson` rejects `Date` and class instances.** A `new Date()` in a payload fails at the boundary, which is the point. Format to ISO strings through `EngineClock`.
- **A tool result's terminal slot is claimed once.** `updateToolTerminal` drops a second terminal record. Repair (2.5) and cancellation both rely on that; do not add a "force" path.
- **`tool.cancel` is `UNIMPLEMENTED`** (S14). Do not offer per-tool cancel in the UI.
- **`toolAborted` publishes no live event** while `toolDenied` publishes `tool.failed`. The client learns about aborts only from durable records, which is why every terminal turn event triggers a refetch (D8 reconciliation rules). Do not "fix" the asymmetry here — it is engine behaviour and changing it is out of scope.
- **The state directory must stay outside the workspace** (D5). `glob` and `grep` skip only `node_modules` and `.git`, so a state directory inside the workspace feeds the model its own transcripts.
- **Shiki is the heaviest new dependency.** Import it lazily and keep the language subset fixed, or first paint regresses and the bundle budget in 6.7 fails.
- **`happy-dom` has no layout.** Scroll tests assert state, not pixels. Write them that way and say so in the test name rather than asserting a number that means nothing.
- **The model has no system prompt and no AGENTS.md** (S15). If the T13 transcript is poor, that is why. It is not this change's bug and not this change's fix.
