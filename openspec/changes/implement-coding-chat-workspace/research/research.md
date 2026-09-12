# Research: Coding Chat Workspace

Date: 2026-09-12

What this change borrows, and from which file. Every path below was opened and read during design; reference repos resolved as siblings of the turnturn repo root, per `openspec/project.md`. All three were present.

Decisions live in `design.md`. This file records the evidence and, where a reference was rejected, why.

---

## turnturn's own precedent, which decided the biggest question

The persistence decision was not open. `openspec/changes/implement-sequential-agent-loop/tasks.md`, "Architectural Debt — Forked Provider-History Reducer", already prescribed it:

> Build that first sink **session-scoped**, one log per session, which is what `JsonlSessionLogWriter` already names. Then sequences are gapless within a session, `reduceProviderHistory` works unmodified, the fork is deleted, and hydration becomes "read this session's log." … Do not build a global file-backed sink in the meantime.

It also named the one thing it left open — *"`conversation.created` spans sessions, so it needs a home — the first session's log, or a small conversation-level log"* — which is what D2 settles, in favour of a two-record header in every session log.

Two more internal sources carried real weight:

- `packages/protocol/src/session-log.ts` — `JsonlSessionLogWriter` and `readSessionLog` already exist, unused, with duplicate-record detection and a `recoveredCorruptTail` signal nothing reads. D1 and D11 are mostly a matter of using what is there.
- `notes/architecture-walkthrough.md`, Part 8 — seven prior bugs. Scar #2 (provider history leaked across conversations) and scar #3 (the forked reducer that fixing #2 produced) are the same failure this change is structurally preventing, one level down: *"when a fix requires duplicating a component, the real problem is usually one level down."*

---

## codex

### Per-thread JSONL as truth, database as derived index

- `codex-rs/rollout/src/lib.rs` — module map: `recorder`, `list`, `session_index`, `state_db`, `reverse_jsonl_scanner`, `writer_lock`, `compression`, `maintenance`.
- `codex-rs/rollout/src/recorder.rs`, `codex-rs/rollout-trace/src/writer.rs` — append-only per-thread writers.
- `codex-rs/rollout/src/state_db.rs`, `codex-rs/rollout/src/metadata.rs` — SQLite, populated by a *backfill* from the rollout files (`BACKFILL_BATCH_SIZE`, `BackfillState`, `apply_rollout_item`).

**Borrowed.** JSONL files are the source of truth; any database is an accelerator built from them. This is the argument that retired SQLite-as-the-store for us (D1): codex operates at a scale where a database earns itself and still does not make it canonical.

**Rejected for v1.** The database layer itself, compression, and log maintenance. `ROADMAP.md` already defers "efficient tail read, log compression and maintenance, session index and search" to v1.x.

### Listing without reading records

- `codex-rs/rollout/src/list.rs` — `ThreadsPage { items, next_cursor, num_scanned_files, reached_scan_cap }` and `ThreadItem { path, thread_id, first_user_message, … }`, ordered newest first.
- `codex-rs/rollout/src/rollout_file_name.rs` — filenames are `rollout-<YYYY-MM-DDThh-mm-ss>-<threadId>.jsonl`, parsed back out of the basename, so a listing sorts by `readdir` without opening a file.
- `codex-rs/rollout/src/session_index.rs` — `session_index.jsonl`, append-only, `SessionIndexEntry { id, thread_name, updated_at }`, with the comment *"Name updates are append-only; the most recent entry wins when resolving names or ids."*

**Borrowed, both halves.** The append-only last-wins index for mutable metadata is D4 almost exactly. Encoding order into the filename is D1's session-file naming (`<ordinal>-<sessionId>.jsonl`), so session order is a lexical sort.

**Adapted rather than copied.** Codex puts the *timestamp and id* in the filename and keeps only names in the index; we put the whole conversation summary in the index and keep ids as directory names. Reason in D4: renaming a directory that holds open file handles is worse than appending a line, and we want id→path to be O(1) rather than a scan.

### First user message as the title

- `codex-rs/rollout/src/list.rs` — `ThreadItem.first_user_message`, and `codex_protocol::protocol::user_message_preview`.

**Borrowed** as D24: derive the title from the first user message, keep an explicit rename as a separate override that derivation never beats.

### Metadata as the log's first line

- `codex-rs/rollout/src/metadata.rs` — `SessionMetaLine` / `builder_from_session_meta(session_meta, rollout_path)`; a summary read is one line, not a file.

**Borrowed** as the shape of D2's log header: the first records of a session log describe the log.

### One protocol, several transports; client protocol versioned separately

- `codex-rs/app-server-transport/src/transport/` — `stdio.rs`, `unix_socket.rs`, `websocket.rs`, `remote_control/`.
- `codex-rs/app-server-protocol/src/protocol/v1.rs` and `protocol/v2/`, plus `schema_fixtures.rs`.

**Borrowed** as D21 (transport is an interface, one implementation now) and D25 (the first separately deployed client is the trigger to version the client-facing protocol). Both were already flagged in `implement-web-client-harness/research/research.md`; this change carries them forward rather than rediscovering them.

### Concurrent writer safety

- `codex-rs/rollout/src/writer_lock.rs`.

**Borrowed** as the state-directory lock in D1: two server processes on one state root would corrupt logs, and `JsonlSessionLogWriter` has no lock of its own.

---

## claude-code

### Markdown and code rendering in a browser

- `claude-code/web/package.json` — `react-markdown@^9`, `remark-gfm@^4`, `shiki@^1.10`, `@tanstack/react-virtual@^3.8`, `zustand`, `swr`.
- `claude-code/web/components/chat/MarkdownContent.tsx` — `<ReactMarkdown remarkPlugins={[remarkGfm]}>` and nothing else; no HTML pass-through.
- `claude-code/web/components/chat/VirtualMessageList.tsx`, `web/hooks/useConversation.ts`, `web/lib/store.ts`.

**Borrowed** as D17: the same four-library stack, for the same reason — a component tree that never parses HTML cannot be made to execute model-supplied script.

**Deliberately diverged** on virtualization (D20). Claude Code virtualizes; we window by "newest 300 plus load earlier". Variable-height content that is also growing character by character during streaming is the standard source of scroll jitter, and scroll correctness is an explicit goal here. The item list is already the right shape if profiling later says otherwise.

### The terminal Markdown path, and why we do not copy it

- `claude-code/src/components/Markdown.tsx` — `marked.lexer` plus a custom `formatToken`, a module-level `tokenCache` of 500 entries keyed by content hash, and an `MD_SYNTAX_RE` fast path that skips the ~3 ms lex for plain text. Its comments record the reasons: *"marked.lexer is the hot cost on virtual-scroll remounts"* and an RSS regression from caching content strings.
- `claude-code/src/components/MarkdownTable.tsx`, `HighlightedCode.tsx`, `StructuredDiff.tsx`, `FilePathLink.tsx`.

**Rejected** as the rendering approach: `marked` produces a token stream because Ink lays out a terminal and never produces DOM. The browser equivalent ends at `dangerouslySetInnerHTML`, over untrusted input.

**Borrowed anyway**, in D17: the content-hash LRU of parsed output and the cheap has-Markdown pre-check. Both are performance lessons that survive the change of renderer, and their comments say what they cost.

**Borrowed** from `FilePathLink.tsx` the *shape* of D19 — a file path is a link whose target is built by a host-specific function (`pathToFileURL` there, an injected `openFile` for us) rather than rendered as bare text. The specific `file://` href does not transfer; a browser refuses to navigate it from an `http://` page.

### Session survival across a dropped connection

- `claude-code/src/server/web/session-store.ts` — sessions outlive their WebSocket for a grace period so a client can reconnect and resume: *"Sessions survive WebSocket disconnects for `gracePeriodMs` before being permanently destroyed."*
- `claude-code/src/server/web/scrollback-buffer.ts` — a 100 KiB circular buffer, *"oldest bytes are silently discarded when the buffer is full."*

**Borrowed** as confirmation of two decisions already in the harness design: a bounded lossy live channel with accepted loss (Amendment C, kept in D8), and reconnect as the common case rather than an edge case. The scrollback buffer is the concrete precedent for B14's bounded queue.

**Rejected.** The grace-period session model. Our sessions are durable files, so reconnect resumes from records rather than from a retained in-memory session — which is strictly stronger and is why D8 needs only `serverInstanceId` to detect a restart.

### Append-only history with a lock

- `claude-code/src/history.ts` — `appendFile`, a `lock()` from `utils/lockfile.js`, `readLinesReverse`, and a `MAX_HISTORY_ITEMS` cap.

**Borrowed** as further support for the append-only-plus-lock shape in D1 and D4, and for compaction by cap rather than by pruning in place.

---

## gemini-cli

### The display view model

- `gemini-cli/packages/cli/src/ui/types.ts` — `HistoryItem` as a discriminated union; `HistoryItemToolGroup { type: 'tool_group'; tools: IndividualToolCallDisplay[] }` at :261; `IndividualToolCallDisplay` at :119 carrying `callId`, `name`, `args`, `description`, `resultDisplay`, `status`, `kind`, `confirmationDetails`, `progressMessage`; and `mapCoreStatusToDisplayStatus` at :76 mapping seven engine statuses onto six display statuses.
- `gemini-cli/packages/cli/src/ui/components/messages/ToolGroupMessage.tsx` — groups render as a unit, with `isCompactTool` and a `COMPACT_OUTPUT_ALLOWLIST` deciding which tools get a condensed view.
- Sibling components: `ToolMessage.tsx`, `ShellToolMessage.tsx`, `DiffRenderer.tsx`, `ToolResultDisplay.tsx`, `ToolConfirmationMessage.tsx`.

**Borrowed, heavily.** This is the closest existing thing to what D14 and D15 specify: a discriminated union of product elements, a tool *group* as a first-class item carrying its calls, one function translating engine status into display status, and per-tool presentation rather than one generic renderer. Our `ConversationViewItem`, `ToolActivityGroupItem`, `ToolCallView`, and `ToolCallDetail` are that shape with turnturn's vocabulary.

**Adapted.** Gemini groups by scheduler batch; we group by `stepId` (D15), because `tool.requested` already carries it and a provider step is the exact unit a wave corresponds to. Gemini's compact-vs-full distinction is an allowlist; ours is per-`presentation`, because our six tools are fixed and their output shapes are known.

**Rejected.** Ink rendering, and the `ToolDisplay`/`SubagentGroupDisplay` layers — subagents are v1.x.

### Validation stays out of the display layer

- `gemini-cli/packages/core/src/agent/event-translator.ts` — contains zero references to `validate` or `schema`; validation lives in `tool.build(args)` called from the scheduler.

**Already borrowed** by loop design Decision 12, and reaffirmed here in the client direction: the projector describes what the engine recorded and never re-derives what should have happened. Where records and expectation disagree it raises a diagnostic and displays the records.

---

## What no reference gave us

Three decisions had no usable precedent in any of the three repos and were reasoned from turnturn's own constraints:

- **D2 — where `conversation.created` lives, and the never-reduce-across-sessions invariant.** Codex has no equivalent, because its rollout files are per thread with no second entity above them sharing a sequence space. This follows from `reduceEngineState`'s parent and contiguity checks, which are ours.
- **D12 — carrying `stepId` on assistant text.** A consequence of turnturn's specific split between one durable `assistant.message.completed` per step and non-durable deltas (loop design Decision 6). Neither reference has that exact asymmetry.
- **D23 — `Host`/`Origin` validation plus a per-process token.** Codex uses stdio and unix sockets, where the boundary is the process; claude-code's web server has real auth (`src/server/web/auth/`). Neither faces our specific situation: an unauthenticated loopback HTTP server whose tool set includes an unsandboxed `shell`. The DNS-rebinding path is standard web security rather than a borrowed pattern.

---

## Verified library availability

Checked against the registry on 2026-09-12: `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `rehype-sanitize@6.0.0`, `shiki@4.4.3`, `@testing-library/react@16.3.3`, `vitest@5.0.0`, `happy-dom@20.14.5`. Claude Code's web client pins older majors of the first four; we take current majors since we have no existing usage to stay compatible with.
