# Design: Web Client Harness

Status: draft for review. Do not implement until reviewed.

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

Consequence: build `apps/web-client` and a local server package/app rather than adding more behavior to `scripts/e2e-turn.mjs`.

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
apps/web-client/
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

## Non-goals

- Disk persistence.
- Login/auth.
- Remote/cloud execution.
- Full product visual design.
- WebSocket transport.
- Editing diff UI beyond readable records/tool output. Rich diff preview remains Milestone 6.
- Changing `packages/protocol`.

