# Tasks: Web Client Harness

Working rule: implement only after `design.md` review. Keep the React client behind the transport boundary; do not import assistant-core into browser code.

Historical harness checklist: checked boxes record work that landed for the original harness. The current server removed the global `/records` route and requires conversation-scoped `/events`; the browser client has since migrated. Remaining product work from the successor change is recorded, unchecked, in `../archive/2026-09-22-implement-coding-chat-workspace/tasks.md`.

## T0 — Project setup

- [x] Add `packages/assistant-server` with TypeScript build/test scripts matching repo conventions.
- [x] Add `apps/web` with React + Vite. Existing app placeholder kept the package name as `apps/web` rather than adding `apps/web-client`.
- [x] Wire root workspace scripts so `pnpm -r build`, `pnpm -r typecheck`, and relevant tests include the new packages.
- [x] Keep server dependencies minimal. Prefer Node built-in `http` for the first server unless Vite integration forces a small framework.

## T1 — Server engine composition

- [x] Build `createLocalAssistantServer(...)` equivalent (`createAssistantRuntime` + `createAssistantHttpServer`) that composes:
  - `createAssistantEngine`
  - `MemoryDurableSink`
  - live broadcaster
  - `createWorkspaceToolExecutor`
  - policy port
  - Ollama/OpenAI-compatible provider config
- [x] Config accepts `workspace`, `provider`, `baseUrl`, `model`, and `maxTokens`.
- [x] Bind to `127.0.0.1` by default.

## T2 — Serialized transport endpoints

- [x] `POST /commands`: parse JSON, round-trip through `serializeJson`/`JSON.parse`, submit to engine, return serialized outcome.
- [x] `GET /events`: stream live events as SSE, one serialized `LiveEvent` per event.
- [x] `GET /records?afterSequence=N`: return durable records with `sequence > N`.
- [x] `GET /debug/state`: return `reduceEngineState(records)` issues and compact runtime diagnostics.
- [x] Test: invalid JSON/non-serializable boundary rejection is exercised at the HTTP boundary.
- [x] Test: `GET /records?afterSequence=N` returns no duplicates and no records at or below `N`.
- [x] Test: live sink publish reaches SSE subscribers and disconnected/non-reading subscribers do not break the engine.

## T3 — Browser transport client

- [x] Implement `transport.ts` with `sendCommand`, `subscribeEvents`, and `fetchRecords`.
- [x] Use browser `EventSource` for `/events`.
- [ ] On reconnect, fetch records after the last durable sequence without a gap. The original client fetches on snapshot, but does not implement the current per-session buffer-and-replay algorithm; see coding-chat-workspace task 4.8.
- [x] Keep command construction in one module so conversation/session/turn ids are not scattered across components.

## T4 — React state and timeline

- [x] Implement a small store/reducer for records, live events, connection state, and pending input.
- [x] Derive the timeline from durable records.
- [ ] Overlay live assistant deltas only for the currently running turn. First implementation shows live events in the timeline; message-level delta stitching still needs a pass.
- [ ] Render:
  - [x] user messages
  - [x] assistant messages
  - [x] tool requests
  - [x] tool terminal results
  - [x] turn terminal state
  - [x] provider failures

## T5 — Turn controls

- [x] Startup creates conversation and session through `POST /commands`.
- [x] Message submit sends `turn.submit`.
- [x] Approval prompt sends `approval.resolve`.
- [x] Cancel button sends `turn.cancel`.
- [ ] Disable duplicate submit while a turn is running unless/until queued turns are designed.

## T6 — Debug panel

- [x] Show durable records as JSON.
- [x] Show live events as JSON.
- [x] Show reducer issues.
- [ ] Show tool definitions being sent to the provider.
- [ ] Add provider request inspection without leaking credentials.

## T7 — Manual Ollama proof

- [ ] Run against a real local Ollama model.
- [ ] Prompt: "Use the available tools to list the files in this repository root, then summarize what you saw."
- [ ] Confirm the model emits a tool call, the engine executes it, the next provider step sees the result, and the UI renders the whole path.
- [ ] Record any failure as a task in the relevant current change, not just chat.

## T8 — Review Amendments

From `design.md` "Review Amendments, 2026-09-12". Amendment B is a correctness hole, not a refinement, so it is not optional.

**Amendment B — the two-call resume race** *(do with T2 and T3, not after)*

- [x] `GET /events` writes an **opening frame carrying `snapshotSequence`** at subscriber registration.
- [ ] Client opens conversation-scoped `/events` first, buffers arrivals, then replays each session through its snapshot cursor before applying the buffer. Deferred to coding-chat-workspace task 4.8; the old client does not buffer.
- [x] Test: append records concurrently with a subscribe, and assert every record is observed **exactly once** — no gap, no duplicate. Superseded session-scoped contract is tested in `packages/assistant-server/test/events-resume.test.mjs`; it also catches the cursor-before-registration gap.

**Amendment A — disarm the SSE cursor**

- [x] Do **not** emit `id:` on `/events`. `EventSource` auto-resends `Last-Event-ID`, which would promise replay on a channel that drops deltas by design.
- [x] Test: asserts no `id:` field appears in the SSE stream, so a future well-meaning change cannot reintroduce it silently.

**Amendment C — a backgrounded tab must not stall the engine**

- [x] Bounded per-subscriber live-event queue; drop deltas on overflow, never durable records.
- [x] At most one gap warning per overflow episode, with a reserved queue slot so it can actually be delivered.
- [x] Test: a subscriber that stops reading does not block an append or prevent a turn from completing. Simulate the throttled-background-tab case, which for a web client is the common case rather than an edge case.

**Amendment D — record the protocol-versioning deferral**

- [x] Reuse the internal protocol types, and note in the change that the first separately-deployed client is the trigger to introduce a versioned client protocol, per codex's `app-server-protocol/src/protocol/v1.rs` + `v2/` + `schema_fixtures.rs`.

**Amendment E — fix bug (h) first**

- [x] Fix bug (h) in `implement-sequential-agent-loop/tasks.md` (T4D) before the T7 Ollama proof. Ollama's OpenAI-compat layer is where tool-call ids are flaky, so the first lane this harness exercises is the one most likely to hit it — and the symptom looks like a client bug: a tool result rendering with no tool start.

## Acceptance

- [x] `pnpm -r build` passes.
- [x] `pnpm -r typecheck` passes.
- [x] Server transport tests pass.
- [ ] Browser client can complete at least one real Ollama tool-using turn.
- [ ] React client never imports assistant-core runtime modules.
- [ ] Resume observes every durable record exactly once under concurrent appends (Amendment B).
- [x] No `id:` field on the SSE stream (Amendment A).
- [x] A non-reading subscriber cannot stall a turn (Amendment C).
