# agentic-code Explorer Report

Read-only exploration complete.

## Observed Relevant Files

- `../agentic-code/src/query.ts`
- `../agentic-code/src/query/config.ts`
- `../agentic-code/src/query/deps.ts`
- `../agentic-code/src/query/transitions.ts`
- `../agentic-code/src/Tool.ts`
- `../agentic-code/src/services/tools/toolOrchestration.ts`
- `../agentic-code/src/services/tools/toolExecution.ts`
- `../agentic-code/src/services/tools/StreamingToolExecutor.ts`
- `../agentic-code/src/types/permissions.ts`
- `../agentic-code/src/utils/permissions/permissions.ts`
- `../agentic-code/src/hooks/useCanUseTool.tsx`
- `../agentic-code/src/hooks/toolPermission/PermissionContext.ts`
- `../agentic-code/src/hooks/toolPermission/handlers/interactiveHandler.ts`
- `../agentic-code/src/remote/sdkMessageAdapter.ts`
- `../agentic-code/src/remote/RemoteSessionManager.ts`
- `../agentic-code/src/remote/SessionsWebSocket.ts`
- `../agentic-code/src/remote/remotePermissionBridge.ts`
- `../agentic-code/src/utils/sessionStorage.ts`
- `../agentic-code/src/cli/structuredIO.ts`
- `../agentic-code/src/services/SessionMemory/sessionMemory.ts`
- `../agentic-code/src/memdir/memdir.ts`
- `../agentic-code/src/tools/AgentTool/AgentTool.tsx`
- `../agentic-code/src/tools/AgentTool/runAgent.ts`
- `../agentic-code/src/utils/forkedAgent.ts`
- `../agentic-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `../agentic-code/src/tasks/LocalMainSessionTask.ts`
- `../agentic-code/src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`

## Architectural Lessons

- The query engine is an async generator lifecycle: it yields stream starts, stream deltas, assistant/user/system/attachment messages, tombstones, and typed terminal reasons.
- The loop defends a central invariant: every assistant `tool_use` must receive a corresponding `tool_result`, including fallback, abort, thrown errors, and streaming retry paths.
- Tool execution is two-layered: orchestration batches concurrency-safe tools, while `runToolUse` owns validation, hooks, permissions, telemetry, execution, result mapping, and post-tool hooks.
- `ToolUseContext` is the shared runtime envelope for tools.
- Remote/local rendering boundaries are adapter-based and lossy.
- Session persistence is append-oriented JSONL with parent UUID chains. Progress is explicitly ephemeral and excluded from durable conversation chains.
- Subagents are query loops with isolated or selectively shared context.
- Memory is split between file-based persistent memory prompts and session-memory extraction via background forked agents.

## Tradeoffs agentic-code Appears To Make

- It favors operational robustness over conceptual purity.
- It centralizes tool-call complexity in `runToolUse`, which makes tool behavior consistent but creates a large coordination hotspot.
- It accepts a broad mutable `ToolUseContext` to keep tool APIs practical.
- It uses append-only persistence for speed and crash tolerance, then pays complexity on load.
- It treats remote sessions as first-class but not identical to local sessions.
- It optimizes hard for prompt-cache stability in forks.

## Recommendations For turnturn v1

- Use a small typed turn state machine from day one.
- Preserve the `tool_use`/`tool_result` invariant as a hard contract.
- Keep canonical messages separate from SDK/render messages.
- Make tool execution context narrower than agentic-code’s `ToolUseContext`.
- Start with serial tool execution plus a concurrency-safe opt-in later.
- Persist transcripts as append-only events, but distinguish durable conversation events from ephemeral progress events.
- Model approvals as a separate service with clear ownership.
- For v1 subagents, prefer simple isolated child sessions with explicit parent summary/context.
- Keep remote execution as a boundary, not a mirror.

## Risks If Copied Too Literally

- The query loop could become a gravity well.
- A broad mutable context can make tests and plugin/tool contracts brittle.
- Copying lossy SDK adapters without a canonical message layer risks UI behavior becoming the de facto protocol.
- Append-only JSONL with parent chains can become a major maintenance surface.
- Permission behavior can become hard to reason about if rules, hooks, classifiers, UI prompts, remote prompts, and subagent prompt suppression all live in the same flow.
- Fork/subagent cache optimization may overfit v1 architecture around provider-specific prompt-cache details.
- Remote/local parity can become illusory.

