# Codex Protocol/Event-Log Research

Scope: `../codex`

## Primary Files

- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/history/src/lib.rs`
- `codex-rs/history/src/rollout_payload.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/protocol/src/response_item_id.rs`
- `codex-rs/rollout/src/ordinal.rs`
- `codex-rs/rollout/src/recorder.rs`
- `codex-rs/rollout/src/policy.rs`
- `codex-rs/core/src/session/rollout_reconstruction.rs`
- `codex-rs/core/src/stream_events_utils.rs`
- `codex-rs/protocol/src/approvals.rs`
- `codex-rs/app-server-protocol/src/rpc.rs`
- `codex-rs/app-server-transport/src/transport/websocket.rs`
- `codex-rs/rollout-trace/README.md`

## Observed Mechanisms

- Core live stream uses `Event { id, msg }`; `id` correlates events to a submission, not a global event sequence.
- Durable rollout schema is `RolloutLine { timestamp, ordinal, item }`.
- Persisted `RolloutItem` is broader than public stream events: session metadata, response items, compaction, turn context, token usage, world state, retained context, security score, selected events, and realtime items.
- Wire payloads are internally tagged as `{ "type": "...", "payload": ... }`.
- UI/app-server canonical item is `ThreadItem`, with variants for user messages, agent messages, reasoning, command execution, file changes, MCP/dynamic tool calls, function outputs, plans, web search, image generation, and subagent/collaboration items.
- Response item IDs use prefixed UUIDv7, while rollout ordering is writer-assigned `ordinal`.
- Ordering guarantee comes from a single append writer, not wall-clock timestamps.
- Durable policy persists model-visible items, completed item snapshots, turn boundaries, compaction/configuration items, and selected executive markers.
- Ephemeral stream events include begin events, deltas, raw chunks, progress, warnings, and most lifecycle notifications used only for live UI.
- Replay reconstructs model history by reverse-scanning to the newest compaction checkpoint, then forward-replaying the surviving suffix.
- Tool calls are persisted before execution; tool outputs are persisted separately after completion so cancellation does not erase the model-visible request.
- Approvals and permission requests are live protocol events, while durable outcomes usually appear through item status, world/permission state, tool output, or turn abort.
- App-server transport is JSON-RPC-like and interleaves requests, responses, errors, and notifications.
- WebSocket transport accepts that clients can lag; snapshots/replay are required rather than relying on live deltas alone.
- Schema evolution is explicit through protocol versions, generated schemas, fixture tests, permissive legacy readers, and migration tests.
- Rollout trace keeps raw diagnostic evidence separate from reduced semantic graphs.

## Tradeoffs

- Keeping live stream events separate from durable rollout items avoids bloating replay state, but requires projection layers.
- Writer-assigned ordinals make resume deterministic, but require a single ordering authority per log.
- Prefixed UUIDv7 IDs are debuggable and globally unique, but still do not replace a total replay order.
- Making approvals mostly ephemeral keeps logs cleaner, but audit-heavy products may need durable request/resolution records.
- Persisting tool calls before execution improves crash/cancel recovery, but requires robust repair/terminal-state handling for interrupted tools.
- Compaction checkpoints keep replay bounded, but add migration and metadata alignment complexity.

## Recommendations For Turnturn Milestone 2

- Use a durable JSONL envelope with `schema_version`, `event_id`, writer-assigned `ordinal`, timestamp, and typed payload.
- Keep canonical durable items separate from live stream/progress events.
- Use prefixed UUIDv7 IDs for semantic entities and a writer-assigned ordinal for total order.
- Persist tool-call request before dispatch, then persist tool result/output independently.
- Model cancellations durably as terminal turn/tool status events.
- Decide whether approval prompts are durable based on audit needs; regardless, persist their model-visible consequence.
- Build projection/replay as explicit reducers rather than letting UI stream events become the history model.
- Add schema fixtures and migration tests before widening the event union.
- Make replay tolerant of bad trailing lines but strict about missing required metadata in canonical modes.
- If diagnostics are added, keep raw evidence local and reduce it offline.
