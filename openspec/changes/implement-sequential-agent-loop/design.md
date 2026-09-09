# Design: Sequential Agent Loop

Status: design gate pending

## Design Goal

Build the first executable engine without weakening the protocol boundary.

The engine accepts `CommandEnvelope`, appends `DurableRecord` through a durable sink, and publishes `LiveEvent` through a live sink. Local tests may use in-memory sinks, but the engine must still communicate through serializable protocol objects.

This design is not implementation-approved until Milestone 3 reference research, user interview, neutral challenge, and synthesis are complete.

## Mandatory Design Inputs

Before implementation starts, preserve:

- User interview notes covering intended design, implementation approach, and failure modes.
- Codex reference research.
- Gemini CLI reference research.
- agentic-code reference research.
- Neutral challenge.
- Synthesis that reconciles the user interview, references, and challenge.

## Boundary Decision

V1 engine code owns:

- command application
- conversation/session/turn lifecycle
- provider-step orchestration
- policy decisions
- sequential tool execution
- command idempotency outcomes
- approval/cancellation race behavior

V1 engine code does not own:

- UI rendering
- provider-native message formats beyond adapter ports
- JSONL file mechanics
- remote transport
- memory consolidation
- subagent orchestration

## First Slice

The first implementation slice defines engine ports in `packages/assistant-core`:

- `ProviderPort` returns scripted assistant messages and tool requests in provider order.
- `ToolExecutorPort` executes one canonical tool request at a time.
- `ToolPolicyPort` returns allow, deny, ask, abort, or modified input decisions.
- `DurableSink` persists durable record drafts and returns writer-assigned durable records.
- `LiveSink` receives renderer/subscriber events after durable facts are written.
- `EngineIds` and `EngineClock` keep ID/time generation injectable for deterministic tests.

How we got here:

- The protocol milestone already separated durable records from live events, so the engine should depend on those types directly rather than inventing a callback API.
- Codex's harness layering points toward ports around provider, tool runtime, persistence, and app rendering.
- Gemini CLI's TypeScript ergonomics support small typed adapter interfaces.
- agentic-code's loop invariants push tool execution and terminal results into explicit engine-owned lifecycle code.

Tradeoffs:

- This creates more test plumbing than a direct `await run(input)` function, but it proves the future transport shape immediately.
- Starting with a scripted provider avoids provider SDK noise while still exercising tool-use/tool-result and replay contracts.
- File persistence stays behind `DurableSink`; tests can use memory while production can later use the JSONL session log.

## Parked Until Later Milestones

- Remote transport belongs to Milestone 4.
- Hydration and recall belong to Milestone 5.
- Parallel tool waves belong to Milestone 6.
- Real provider adapters get their own follow-on milestone after the scripted loop stabilizes.
