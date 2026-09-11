# Research: Web Client Harness

Date: 2026-09-12

## turnturn context

Milestone 3 already requires a minimal renderer that subscribes through the serialized transport rather than directly to the engine. The current implementation has an e2e script, but not a reusable client boundary.

The important settled rule is Decision 7 in `openspec/changes/implement-sequential-agent-loop/design.md`: every command and event crosses a serialized boundary; resume is by durable record sequence, never live-event id.

## References inspected

### Claude Code — WebSocket session manager

Files:

- `../claude-code/src/remote/RemoteSessionManager.ts`
- `../claude-code/src/remote/SessionsWebSocket.ts`

Borrowed ideas:

- Separate command sending from event subscription. `RemoteSessionManager` coordinates HTTP-like sends plus a WebSocket subscription; it does not let UI code own the session protocol.
- Treat connection state as user-visible: connected, reconnecting, disconnected, error.
- Permission/approval prompts are control messages with request ids, not callback references.

Rejected for v1:

- WebSocket as the first local transport. Claude Code needs a bidirectional remote session channel. turnturn v1 only needs client-to-server commands plus server-to-client event stream, so POST plus SSE is simpler and maps directly to durable replay.
- Reconnect backoff complexity. Localhost SSE can start with browser `EventSource` reconnection and explicit record replay.

### Codex — local HTTP/SSE conformance discipline

Files:

- `../codex/scripts/mcp_conformance/test_server.py`
- `../codex/AGENTS.md`

Borrowed ideas:

- Test the streaming boundary as bytes/protocol, not just in-process callbacks.
- Localhost HTTP is a legitimate conformance harness when the goal is proving wire behavior.
- SSE edge cases matter enough to deserve their own tests and fixtures.

Rejected for v1:

- A broad conformance server. The web harness needs only the app transport endpoints that the React client uses.

### Gemini CLI — React state ergonomics

Files:

- `../gemini-cli/GEMINI.md`
- `../claude-code/src/context/voice.tsx`
- `../claude-code/src/context/QueuedMessageContext.tsx`

Borrowed ideas:

- React can be the renderer even when the underlying app is not browser-native; state should be held behind a small store/context and subscribed to by components.
- Use narrow hooks/selectors so rendering logic does not become protocol orchestration.
- Keep UI state separate from engine state: UI derives a timeline from durable/live events instead of mutating engine objects.

Rejected for v1:

- Ink/terminal rendering. The target reusable client surface is browser React, not terminal React.

## Design conclusion

Build a local HTTP server with:

- `POST /commands` for serialized `CommandEnvelope` submission.
- `GET /events` for live `LiveEvent` SSE.
- `GET /records?afterSequence=N` for durable replay/resume.
- `GET /debug/state` for reducer issues and operator diagnostics.

Build a React web client that treats those endpoints as the only engine boundary. The client never imports `@turnturn/assistant-core`.

