# Design: Harness Boundaries

Status: challenged and narrowed

## Boundary Map

```text
client / renderer
  -> transport
  -> app/session facade
  -> engine
  -> provider adapters
  -> tool orchestrator
  -> runtime executor
  -> persistence
  -> observability
```

## v1 Boundary Decision

v1 should define a transport-safe protocol but implement only an in-process transport first. This is acceptable only if every command/event is validated through JSON serialization round-trip fixtures before engine work relies on it.

How we got there:

- Codex shows the value of a protocol/event boundary between core and TUI/app/server surfaces.
- Gemini CLI shows SDK ergonomics can sit over a session abstraction.
- agentic-code shows adapters are necessary, but renderer state must not become executable truth.

Tradeoffs:

- In-process only is fastest but may hide serialization problems.
- Local HTTP/SSE/WebSocket first makes transport real but slows the harness spine.
- A transport abstraction with in-process implementation gives the best balance if all commands/events remain JSON-serializable and resumable.

Decision:

- Define `TransportCommand` and `EngineEvent` as serializable protocol types.
- Implement `InProcessTransport` in v1.
- Design `SseTransport` / `WebSocketTransport` as future adapters, not v1 implementation.
- Require tests proving commands/events round-trip through plain JSON without functions, class instances, symbols, Dates, or provider-native objects.
- Require subscription ordering and resume semantics with `afterEventId`.

## Narrowed v1 Implementation Gate

Engine implementation must not start until the protocol/event-log milestone answers:

- event identity and ordering
- schema versioning
- durable vs ephemeral event rules
- parent/causal IDs
- tool-use/tool-result state machine
- approval resolution semantics
- cancellation race semantics
- replay fixture requirements

This changes the milestone sequence: protocol/event-log contracts come before engine scaffolding.

## Engine Boundary

The engine owns:

- conversation/session/turn/step lifecycle
- model step loop
- tool-use/tool-result invariant
- policy gate invocation
- persistence writes
- cancellation propagation
- trace event emission

The engine does not own:

- UI rendering
- provider-native message formats
- shell process mechanics
- user credential storage UI
- remote transport implementation

## Client and Renderer Boundary

Renderers subscribe to canonical events and send commands. They do not import engine internals.

Renderer commands include:

- submit user input
- answer approval request
- cancel turn
- resume subscription after event ID

## App/Session Facade Boundary

v1 should define app/session responsibilities, but not implement a separate app/session server unless a second client appears.

Responsibilities:

- create conversation
- create session
- attach renderer/subscriber
- route approval responses
- route cancellation
- expose session metadata

Out of v1:

- multi-user auth
- hosted app server
- remote worker management
- websocket fanout

Decision:

- Keep app/session facade as a module-level API in v1.
- Do not create an app-server package yet.
- Revisit when local HTTP/SSE/WebSocket transport is needed.

## Runtime Executor Boundary

Tools should not spawn shell processes directly from engine logic. Shell/filesystem execution belongs behind executor interfaces.

v1 executor:

- local process executor
- cwd/workspace root awareness
- timeout/cancellation support
- bounded output capture

Out of v1:

- cloud sandbox
- remote exec server
- per-OS sandbox parity

## Provider Boundary

The provider layer adapts canonical model requests into provider-specific API calls and returns canonical stream events.

Core types must not expose provider-native messages as durable truth.

## Tool and Policy Boundary

Tool execution splits into:

- definition
- invocation
- policy decision
- scheduler
- executor
- result mapping

Approval is serializable and resolves exactly once.

## Persistence Boundary

Persistence stores append-only canonical events. Hydration and replay are derived from that store.

Durable events are separate from ephemeral progress events.

## Observability Boundary

Tracing is not a renderer feature. For v1, observability is structured engine events plus trace IDs. Do not create a separate observability subsystem before the timeline renderer exists.

## Memory and Subagent Boundary

v1 reserves protocol discussion only:

- memory as summaries/facts separate from replay
- subagents as child sessions with parent linkage

No memory or subagent implementation interfaces should be created in the first engine milestone unless needed by event identity or future lineage fields.

## Missing Areas From Baseline Roadmap

- transport-safe command protocol
- app/session facade responsibilities
- executor boundary
- durable vs ephemeral event distinction
- auth/identity placeholder
- workspace/environment policy placeholder
- schema versioning
- subscription resume via `afterEventId`

## Explicit Deferrals

- Local HTTP/SSE/WebSocket transport implementation.
- Hosted app server or Codex-app-server equivalent.
- Remote executor/server.
- Full MCP runtime.
- Memory consolidation implementation.
- Subagent execution implementation.
- Rich observability subsystem beyond structured events and trace IDs.
