# Gemini CLI Protocol/Event-Log Research

Scope: `../gemini-cli`

## Primary Files

- `packages/core/src/agent/types.ts`
- `packages/core/src/agent/agent-session.ts`
- `packages/core/src/agent/legacy-agent-session.ts`
- `packages/core/src/agent/event-translator.ts`
- `packages/core/src/scheduler/types.ts`
- `packages/core/src/scheduler/scheduler.ts`
- `packages/core/src/scheduler/state-manager.ts`
- `packages/core/src/scheduler/confirmation.ts`
- `packages/core/src/scheduler/tool-executor.ts`
- `packages/core/src/confirmation-bus/types.ts`
- `packages/core/src/confirmation-bus/message-bus.ts`
- `packages/core/src/services/chatRecordingTypes.ts`
- `packages/core/src/services/chatRecordingService.ts`
- `packages/sdk/src/agent.ts`
- `packages/sdk/src/session.ts`
- `packages/sdk/src/tool.ts`
- `packages/cli/src/acp/acpSession.ts`
- `packages/cli/src/acp/acpSessionManager.ts`
- `packages/cli/src/acp/acpStdioTransport.ts`

## Observed Mechanisms

- `AgentProtocol` is small and event-first: `send(payload)`, `subscribe(callback)`, `abort()`, and readonly `events`.
- `send` returns `{ streamId }`; when activity starts, the stream ID must exist before `agent_start`.
- `AgentEvent` includes `id`, optional `threadId`, required `streamId`, timestamp, type, and optional metadata.
- Event types include initialization, session updates, messages, agent start/end, tool request/update/response, elicitation request/response, usage, errors, and custom events.
- Legacy event IDs are stream-local counters like `${streamId}-${counter}`.
- `AgentSession.stream({ eventId | streamId })` replays over in-memory events, subscribes before replay to avoid missed events, filters by stream, and yields from `agent_start` through `agent_end`.
- Tool lifecycle internally is richer than public events: validating, scheduled, executing, awaiting approval, success, error, cancelled.
- Public events flatten tools to request/update/response, while scheduler state flows through a separate message bus.
- Confirmation uses correlation IDs and request/response messages, but still has legacy callback and IDE-promise leakage around confirmation details.
- Cancellation is layered: protocol abort controller, scheduler cancel, confirmation abort signal, and executor conversion into cancelled tool results where possible.
- Session recording is JSONL, but it stores conversation projections and metadata operations rather than a canonical event log.
- JSONL load folds records into metadata/message maps, applies rewinds/checkpoints, and ignores invalid lines.
- Resume rebuilds provider history from loaded conversation messages, not by replaying canonical agent events.
- ACP transport is NDJSON over stdio with its own session updates, permissions, stop reasons, and tool statuses.

## Tradeoffs

- The protocol is SDK-friendly and easy to subscribe to.
- Subscribe-before-replay avoids a common resume race.
- Confirmation correlation IDs point in the right transport direction.
- Stream-local event IDs are readable, but insufficient for cross-stream ordering or durable replay.
- Splitting scheduler state from public agent events is ergonomic for UI but creates multiple truth planes.
- JSONL conversation projection is append-friendly, but it cannot serve as full causal event history.
- Callback leakage across confirmation boundaries makes serialization and remote approval harder.

## Recommendations For Turnturn Milestone 2

- Make canonical events the durable source of truth, not projected conversation messages.
- Use both storage-assigned sequence/ordinal and semantic IDs such as stream, turn, step, tool call, and approval IDs.
- Keep stream IDs as activity correlation keys, not as the only ordering domain.
- Persist tool transitions explicitly: requested, validating, approval requested/resolved, scheduled, started, output delta or snapshot, completed, failed, cancelled.
- Make approvals first-class commands/events keyed by approval ID, with once-only resolution and defined stale-response behavior.
- Define cancellation commands separately for turn, stream/step, tool call, and approval request.
- Keep callbacks, promises, provider SDK objects, file handles, abort signals, and error instances out of durable protocol.
- Serialize errors as structured data with code/status, message, fatality, optional cause, and details.
- Add replay fixtures for normal turn, approval denial, approved tool success, awaiting-approval cancellation, execution cancellation, and resume after cursor.
- Offer ergonomic SDK methods over canonical protocol instead of making the protocol itself callback-oriented.
- Even if Milestone 2 uses in-process transport first, force JSON round-trip tests for every command/event.
