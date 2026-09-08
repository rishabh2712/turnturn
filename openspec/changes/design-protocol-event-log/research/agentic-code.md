# agentic-code Protocol/Event-Log Research

Scope: `../agentic-code`

## Primary Files

- `src/types/message.ts`
- `src/types/logs.ts`
- `src/utils/sessionStorage.ts`
- `src/cli/print.ts`
- `src/entrypoints/sdk/coreSchemas.ts`
- `src/utils/messages/mappers.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/utils/messages.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/entrypoints/sdk/controlSchemas.ts`
- `src/cli/structuredIO.ts`
- `src/remote/RemoteSessionManager.ts`
- `src/bridge/bridgeMessaging.ts`
- `src/cli/transports/WebSocketTransport.ts`
- `src/cli/transports/SSETransport.ts`
- `src/cli/transports/HybridTransport.ts`
- `src/cli/transports/SerialBatchEventUploader.ts`
- `src/services/api/sessionIngress.ts`
- `src/cli/transports/ccrClient.ts`

## Observed Mechanisms

- Runtime messages are discriminated as assistant, user, system, and progress.
- Assistant runtime messages wrap provider messages and carry UUID, timestamp, request ID, agent ID, and error fields.
- User runtime messages can carry tool results, source assistant UUID, virtual/meta flags, permission mode, and origin.
- Progress messages carry tool-use IDs but are UI progress, not durable transcript participants.
- Durable JSONL entries mix transcript messages with summaries, titles, tags, agent metadata, file/attribution snapshots, queue operations, worktree state, content replacements, and context-collapse records.
- Transcript messages add parent UUID, logical parent UUID, sidechain status, agent ID, prompt ID, cwd, user type, entrypoint, session ID, version, branch, and slug.
- Session files materialize lazily on first user/assistant message; metadata-only sessions are buffered.
- Writes are queued per file, batched, async, and deduped by UUID.
- Tool result user messages can override parentage through source assistant UUID.
- Compact boundaries can break physical parentage while preserving logical parentage.
- Subagent transcripts live in separate per-agent JSONL files.
- Loader rebuilds metadata maps, bridges legacy progress entries, relinks compact/snip boundaries, computes leaf nodes, and builds conversation chains from parent links.
- Parallel tools make the transcript graph-like; pure linked-list replay can orphan sibling tool calls/results.
- `recoverOrphanedParallelToolResults()` explicitly repairs sibling tool results.
- SDK envelopes differ from internal JSONL entries; adapters map between local runtime messages and SDK messages.
- Tool results are detected by content shape because `parent_tool_use_id` is not reliable enough alone.
- Every assistant tool use should receive a user tool result.
- Unknown tools, input validation failures, permission denial, abort/cancel, and runtime failure all yield error tool results.
- Repair code can synthesize missing tool results, strip orphaned results, and dedupe duplicate tool IDs.
- Approval/control protocol is keyed by request ID, while model-visible tool lifecycle is keyed by tool-use ID.
- Remote transport uses WebSocket, SSE, and hybrid modes with reconnect, buffering, sequence offsets, idempotent UUIDs, serialized uploads, batching, backoff, and backpressure.
- Remote persistence separates client-visible events from internal durable worker events.

## Tradeoffs

- Append-only JSONL is simple and recoverable, but mixed entry taxonomy makes loaders accumulate special cases.
- Parent chains support branch/fork/compact recovery, but parallel tools force graph-aware replay.
- Keeping progress out of transcript history avoids resume truncation; legacy persisted progress required bridging repairs.
- Synthetic tool-result repair keeps sessions alive, but synthetic output can poison evaluations unless explicitly marked.
- Fire-and-forget persistence improves latency, but user messages need eager flushes before long work to reduce crash windows.
- Sequence offsets make replay cleaner than last-UUID only; UUID idempotency remains useful as a safety net.

## Recommendations For Turnturn Milestone 2

- Define three envelopes explicitly: durable transcript/event, ephemeral progress, and control-plane command/event.
- Keep progress out of parent chains; key it by tool-use ID and discard or snapshot it.
- Make tool pairing a hard invariant: each `tool_use.id` has exactly one `tool_result.tool_use_id`.
- Ensure cancellation, denial, validation failure, unknown tool, and runtime failure all produce model-visible tool results where provider protocols require it.
- Separate approval lifecycle keyed by approval/request ID from model-visible tool lifecycle keyed by tool-use ID.
- Do not make approval events substitute for tool results.
- Use ordered sequence numbers for remote streams plus UUID/idempotency keys for dedupe.
- Serialize writes per session.
- Define hydration as materializing a canonical event stream into local read models.
- Treat compaction as a first-class event with explicit preserved segments and relink metadata.
- Add replay tests for parallel tools, interrupted tools, approval denial, orphan results, duplicate IDs, compact boundaries, reconnect duplicates, and partial remote hydration.
