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

## Added 2026-09-12: Codex `app-server`, the closest analog

The section above cites a codex conformance test script. The more relevant codex reference was missed: `app-server` is six crates whose whole job is exposing the engine to clients over a transport — exactly this change's problem.

| Crate | Non-test lines |
| --- | --- |
| `app-server` | 55,293 |
| `app-server-protocol` | 34,309 |
| `app-server-transport` | 16,799 |
| `app-server-daemon` | 6,512 |
| `app-server-test-client` | 4,082 |
| `app-server-client` | 3,277 |

Not a volume model — but three structural decisions are worth knowing.

**It is JSON-RPC 2.0, not REST.** `app-server-protocol/src/rpc.rs` defines `JSONRPCMessage` as `Request | Notification | Response | Error`. Commands are requests with ids; server-to-client events are **notifications**, which carry no id and expect no reply. That is the same asymmetry as our commands-versus-events split, expressed in one envelope instead of three endpoints.

**One protocol, four transports.** `app-server-transport/src/transport/` contains `stdio.rs`, `unix_socket.rs`, `websocket.rs`, and `remote_control/`. The protocol is transport-agnostic and the transport is swappable. That is precisely the property this change wants for later Electron reuse, and it argues for keeping transport concerns in one module rather than spread through route handlers.

**The client-facing protocol is versioned separately from the internal one.** `app-server-protocol/src/protocol/v1.rs` and `protocol/v2/`, plus `schema_fixtures.rs` to catch breaking changes. Codex deliberately did not publish its internal types to clients.

## Added 2026-09-12: the transport choice is genuinely contested

The section above says Claude Code chose WebSocket and implies turnturn is the simpler case. The actual split across all three references:

| Reference | Client transport | Evidence |
| --- | --- | --- |
| codex | JSON-RPC over stdio / unix socket / WebSocket / remote-control. **No SSE.** | `app-server-transport/src/transport/` |
| claude-code | WebSocket | `src/server/directConnectManager.ts:41-56` |
| gemini-cli | **HTTP + SSE** | `packages/a2a-server/src/http/app.ts:162` sets `text/event-stream` |

Two of three chose bidirectional sockets. So "SSE because we do not need bidirectional" is a weaker argument than it reads — but the conclusion still holds, for a turnturn-specific reason the draft did not give:

**SSE's native `id:` field and `Last-Event-ID` reconnect header implement resume-by-cursor at the protocol level**, which is the exact semantic Decision 7 and B15 already committed to. No other transport gives that for free.

**And that is also a trap — see Amendment A in `design.md`.** The cursor SSE offers is for the *live* stream, which is deliberately lossy. Using it would promise replay on a channel that drops deltas by design.

One more from claude-code worth carrying: `src/server/web/scrollback-buffer.ts` is a **100 KiB circular buffer** for replaying the lossy channel to a reconnecting client. It is the concrete precedent for B14's bounded live-event queue, and it shows the pragmatic answer to "what if the client is gone a long time" is a cap plus accepted loss.

## Design conclusion

Build a local HTTP server with:

- `POST /commands` for serialized `CommandEnvelope` submission.
- `GET /events` for live `LiveEvent` SSE.
- `GET /records?afterSequence=N` for durable replay/resume.
- `GET /debug/state` for reducer issues and operator diagnostics.

Build a React web client that treats those endpoints as the only engine boundary. The client never imports `@turnturn/assistant-core`.

