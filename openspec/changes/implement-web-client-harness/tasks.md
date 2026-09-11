# Tasks: Web Client Harness

Working rule: implement only after `design.md` review. Keep the React client behind the transport boundary; do not import assistant-core into browser code.

## T0 — Project setup

- [ ] Add `packages/assistant-server` with TypeScript build/test scripts matching repo conventions.
- [ ] Add `apps/web-client` with React + Vite.
- [ ] Wire root workspace scripts so `pnpm -r build`, `pnpm -r typecheck`, and relevant tests include the new packages.
- [ ] Keep server dependencies minimal. Prefer Node built-in `http` for the first server unless Vite integration forces a small framework.

## T1 — Server engine composition

- [ ] Build `createLocalAssistantServer(...)` that composes:
  - `createAssistantEngine`
  - `MemoryDurableSink`
  - live broadcaster
  - `createWorkspaceToolExecutor`
  - policy port
  - Ollama/OpenAI-compatible provider config
- [ ] Config accepts `workspace`, `provider`, `baseUrl`, `model`, and `maxTokens`.
- [ ] Bind to `127.0.0.1` by default.

## T2 — Serialized transport endpoints

- [ ] `POST /commands`: parse JSON, round-trip through `serializeJson`/`JSON.parse`, submit to engine, return serialized outcome.
- [ ] `GET /events`: stream live events as SSE, one serialized `LiveEvent` per event.
- [ ] `GET /records?afterSequence=N`: return durable records with `sequence > N`.
- [ ] `GET /debug/state`: return `reduceEngineState(records)` issues and compact runtime diagnostics.
- [ ] Test: non-serializable command payloads are rejected at the boundary.
- [ ] Test: `GET /records?afterSequence=N` returns no duplicates and no records at or below `N`.
- [ ] Test: live sink publish reaches SSE subscribers and throwing/disconnected subscribers do not break the engine.

## T3 — Browser transport client

- [ ] Implement `transport.ts` with `sendCommand`, `subscribeEvents`, and `fetchRecords`.
- [ ] Use browser `EventSource` for `/events`.
- [ ] On reconnect, fetch records after the last durable sequence.
- [ ] Keep command construction in one module so conversation/session/turn ids are not scattered across components.

## T4 — React state and timeline

- [ ] Implement a small store/reducer for records, live events, connection state, and pending input.
- [ ] Derive the timeline from durable records.
- [ ] Overlay live assistant deltas only for the currently running turn.
- [ ] Render:
  - user messages
  - assistant messages
  - tool requests
  - tool terminal results
  - turn terminal state
  - provider failures

## T5 — Turn controls

- [ ] Startup creates conversation and session through `POST /commands`.
- [ ] Message submit sends `turn.submit`.
- [ ] Approval prompt sends `approval.resolve`.
- [ ] Cancel button sends `turn.cancel`.
- [ ] Disable duplicate submit while a turn is running unless/until queued turns are designed.

## T6 — Debug panel

- [ ] Show durable records as JSON.
- [ ] Show live events as JSON.
- [ ] Show reducer issues.
- [ ] Show tool definitions being sent to the provider.
- [ ] Add provider request inspection without leaking credentials.

## T7 — Manual Ollama proof

- [ ] Run against a real local Ollama model.
- [ ] Prompt: "Use the available tools to list the files in this repository root, then summarize what you saw."
- [ ] Confirm the model emits a tool call, the engine executes it, the next provider step sees the result, and the UI renders the whole path.
- [ ] Record any failure as a task in the relevant current change, not just chat.

## Acceptance

- [ ] `pnpm -r build` passes.
- [ ] `pnpm -r typecheck` passes.
- [ ] Server transport tests pass.
- [ ] Browser client can complete at least one real Ollama tool-using turn.
- [ ] React client never imports assistant-core runtime modules.

