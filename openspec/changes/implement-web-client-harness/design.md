# Design: Web Client Harness

Status: historical harness design. The first server/client harness landed, but its global replay API and browser client are being superseded by `implement-coding-chat-workspace`; this document is not the current client contract.

## What we are building

A local React web client plus local Node server that drives the real assistant engine through serialized transport.

```text
Browser React client
  -> POST /commands
  <- GET /events       live SSE
  <- GET /records      durable replay
Local web server
  -> in-process assistant engine
Provider / tools / policy / durable log
```

This is not the final product UI. It is the first reusable client harness for manual testing, later Electron reuse, and renderer design.

## Decision 1: Web harness, not CLI

A CLI would prove a turn loop but would not become the Electron/browser surface. The web client proves the boundary we actually need later:

```text
React renderer
  <-> serialized transport
main process / local server
  <-> engine
```

Consequence: build the existing `apps/web` React app and a local server package/app rather than adding more behavior to `scripts/e2e-turn.mjs`.

## Decision 2: React never imports assistant-core

The React app talks only to HTTP/SSE endpoints. It does not import `createAssistantEngine`, provider adapters, tool executors, or protocol reducers from assistant-core.

Why: importing the engine into React would collapse the exact boundary we are trying to prove. Electron later has the same renderer/main split. If the browser client cheats now, the Electron client pays the debt later.

The server may import assistant-core and protocol. The client may import protocol types only if they compile to type-only usage; runtime protocol logic stays server-side for this change.

## Decision 3: POST commands, SSE live events, HTTP replay

Use three endpoints:

```text
POST /commands
GET  /events
GET  /records?afterSequence=N
```

`POST /commands` accepts a JSON command envelope and returns the serialized command outcome.

`GET /events` streams live events as SSE. Each event body is a serialized `LiveEvent`. SSE is enough because server-to-client is one-way and commands already have POST.

`GET /records?afterSequence=N` returns durable records with `sequence > N`. Resume is durable-record based; live-event ids are not resume cursors.

Why not WebSocket first:

- Claude Code uses WebSocket for remote bidirectional sessions, but turnturn's v1 local harness does not need bidirectional streaming.
- POST plus SSE is simpler to test with browser APIs, curl, and Node's built-in HTTP stack.
- It matches Decision 7's asymmetry: commands are requests, live events are ephemeral, durable records are replay.

WebSocket remains available later if remote hosted execution needs a single channel.

## Decision 4: In-memory server state for this harness

The server owns one engine instance, one durable sink, and one live broadcaster for the current process.

No disk-backed session log in this change. Process restart durability is Milestone 7. The web harness still exercises resume within a running process by reconnecting with `afterSequence`.

## Decision 5: Localhost only, no auth

The server binds to `127.0.0.1` by default. No auth is added in this change.

If a user wants remote access, that is a different security problem. The local harness must not accidentally become a remote service.

## Decision 6: Ollama first, provider config explicit

The first provider lane is Ollama through the OpenAI-compatible chat adapter:

```text
provider: openai-chat-completions preset
baseUrl: http://127.0.0.1:11434
model: configured by user
```

The server config should also allow the LiteLLM/OpenAI-compatible lane because the adapter already supports it, but the default manual path is local Ollama.

## Decision 7: Debug panel is first-class

The client must expose:

- provider request body from the latest step when inspection is enabled
- durable records
- live events
- reducer issues from `reduceEngineState`
- tool definitions sent to the model
- connection status

This is not decoration. The current risk is understanding the real turn loop against a real model, and the debug panel is how failures become diagnosable.

## Decision 8: Approval and cancellation are commands

Approval prompts are rendered from live/durable events, but resolving one is a `CommandTypes.ApprovalResolve` command sent through `POST /commands`.

Cancellation is a `CommandTypes.TurnCancel` command sent through the same endpoint.

No callback handle or promise resolver crosses into React.

## Decision 9: Client state is a projection

The React app keeps a small local store:

```text
connection status
durable records by sequence
live events since connection
pending input text
selected debug tab
```

The timeline is derived from records plus live deltas. Completed assistant messages come from durable records; live text deltas are only optimistic display. On reconnect, the client fetches records after the last durable sequence and repairs its view from durable truth.

## Package layout

```text
apps/web/
  package.json
  index.html
  src/
    main.tsx
    App.tsx
    transport.ts
    store.ts
    timeline.ts
    components/

packages/assistant-server/
  package.json
  src/
    server.ts
    engine-factory.ts
    sse.ts
    routes.ts
    config.ts
  test/
```

`assistant-server` owns engine composition and HTTP transport. `web-client` owns rendering only.

## Review Amendments, 2026-09-12

Added in review against `research/research.md`. Decisions 1–9 stand; these tighten them. Amendment B is a correctness hole rather than a refinement.

### Amendment A: keep SSE, but never set `id:` on the live stream

Decision 3's conclusion is right and its stated reason is the weak one. The reference split is 2-to-1 *against* SSE (codex: JSON-RPC over stdio/unix-socket/WebSocket; claude-code: WebSocket; gemini-cli: SSE). The real turnturn-specific argument is that **SSE implements resume-by-cursor at the protocol level** via `id:` and `Last-Event-ID`, which is the semantic Decision 7 and B15 already require.

That same feature is a trap here, and it must be actively disarmed:

- `EventSource` **automatically** resends `Last-Event-ID` on reconnect if any `id:` was ever emitted.
- The live stream is deliberately lossy — B14 drops deltas under backpressure.
- So emitting `id:` promises replay on a channel that cannot honour it, and the browser will silently act on that promise.

**Do not set `id:` on `/events` at all.** Resume goes through `GET /records?afterSequence=N` exclusively, which is durable and complete. If `id:` is ever added later it must carry a durable record sequence, never a live-event identifier — `LiveEvent.sequence` is typed `never` specifically to block that.

### Amendment B: the two-call resume race

Decision 9 says the client "fetches records after the last durable sequence and repairs its view". As two separate HTTP calls that loses data, in both orders:

```text
fetch /records?afterSequence=20  ->  then open /events
     anything appended between the two is never seen

open /events  ->  then fetch /records?afterSequence=20
     no way to know which records the stream already covers
```

B15 requires a clear boundary between replay and live delivery. HTTP cannot hold a lock across two requests, so the opening stream frame has to carry the cursor:

1. Client opens `GET /events?conversationId=C` **first**.
2. Server registers the subscriber before synchronously collecting each session's `lastSequence`. Events published during collection are queued; the snapshot is sent as the first frame, then the queue drains.
3. Client buffers live events as they arrive.
4. For each session, client fetches its scoped records after the last held sequence, taking records up to that session's snapshot cursor.
5. Client then applies its buffered live events.

Everything at or below a session's snapshot cursor comes from durable replay; later live events remain available from the already-registered subscriber. The server does not hold an append mutex across these HTTP requests. The current per-session contract and server-side boundary test live in `implement-coding-chat-workspace` Decision 8 and `packages/assistant-server/test/events-resume.test.mjs`. The old browser client has not implemented this new resume algorithm yet.

This is exactly the bug B15 exists to prevent, so the harness must have a test for it: append records concurrently with a subscribe, and assert every record is observed exactly once.

### Amendment C: a backgrounded browser tab must not stall the engine

The design does not say what happens when the SSE consumer stops reading — and for a web client that is the *common* case, not an edge case, because browsers throttle background tabs.

Carry B14 into the server explicitly:

- Bounded per-subscriber queue for live events.
- On overflow, drop **deltas**; never drop durable records.
- Emit at most one gap warning per overflow episode, with a queue slot reserved for it — otherwise the notification about a full queue cannot get through the full queue.
- A stalled or disconnected subscriber must never block an append or a turn.

Precedent: claude-code's `src/server/web/scrollback-buffer.ts` is a 100 KiB circular buffer serving exactly this purpose.

### Amendment D: reusing the internal protocol is a deliberate deferral

Decision 2 lets the client use protocol types type-only and the proposal reuses `CommandEnvelope` / `DurableRecord` / `LiveEvent` directly. Correct for a harness, and worth naming as a deferral rather than a conclusion.

Codex versions its client-facing protocol separately — `app-server-protocol/src/protocol/v1.rs`, `v2/`, with `schema_fixtures.rs` guarding breaking changes — precisely because a client that ships separately from the server turns the wire format into a published API. `SCHEMA_VERSION` alone will not be enough then.

For this change: reuse the internal types, and record that the first separately-deployed client is the trigger to introduce a versioned client protocol.

### Amendment E: Ollama-first collides with an unfixed adapter bug

Decision 6 makes the first manual lane Ollama through the OpenAI-compatible adapter. Bug (h) in `implement-sequential-agent-loop/tasks.md` — a tool call with no provider id produces a `tool-call-complete` that never started, and sends a synthetic id back to the provider — is still open, and Ollama's OpenAI-compat layer is exactly where tool-call ids are flaky.

So the first lane the harness exercises is the one most likely to hit it, and the symptom will look like a client bug: a tool result appearing with no tool start. Fix bug (h) before or during this change, or expect to debug the wrong layer.

## Non-goals

- Disk persistence.
- Login/auth.
- Remote/cloud execution.
- Full product visual design.
- WebSocket transport.
- Editing diff UI beyond readable records/tool output. Rich diff preview remains Milestone 6.
- Changing `packages/protocol`.
