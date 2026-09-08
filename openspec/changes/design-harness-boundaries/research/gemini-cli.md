# Gemini CLI Explorer Report

## Observed Relevant Files

- `../gemini-cli/packages/core/src/config/agent-loop-context.ts`
- `../gemini-cli/packages/core/src/agent/{types.ts,agent-session.ts,legacy-agent-session.ts,event-translator.ts}`
- `../gemini-cli/packages/core/src/core/{client.ts,turn.ts,geminiChat.ts,contentGenerator.ts,baseLlmClient.ts,loggingContentGenerator.ts,modelMappingContentGenerator.ts}`
- `../gemini-cli/packages/core/src/tools/{tools.ts,tool-registry.ts,mcp-client.ts,mcp-tool.ts,tool-error.ts}`
- `../gemini-cli/packages/core/src/scheduler/{scheduler.ts,types.ts,confirmation.ts,policy.ts,tool-executor.ts}`
- `../gemini-cli/packages/core/src/confirmation-bus/{message-bus.ts,types.ts}`
- `../gemini-cli/packages/core/src/services/{chatRecordingService.ts,chatRecordingTypes.ts}`
- `../gemini-cli/packages/core/src/utils/{sessionOperations.ts,checkpointUtils.ts,events.ts}`
- `../gemini-cli/packages/core/src/policy/{types.ts,policy-engine.ts}`
- `../gemini-cli/packages/core/src/hooks/{types.ts,hookSystem.ts}`
- `../gemini-cli/packages/core/src/agents/{types.ts,agent-tool.ts,agent-scheduler.ts,registry.ts,local-executor.ts,local-session-invocation.ts,local-subagent-protocol.ts}`
- `../gemini-cli/packages/core/src/telemetry/{trace.ts,loggers.ts}`
- `../gemini-cli/packages/sdk/src/{agent.ts,session.ts,tool.ts,types.ts}`

## Architectural Lessons

- Make the primary runtime contract event-first. Gemini’s newer `AgentProtocol` exposes `send`, `subscribe`, `abort`, and immutable `events`; `AgentSession.stream()` adds replay/resume by `eventId` or `streamId`.
- Keep `AgentLoopContext` small but explicit: config, prompt/session id, registries, message bus, model client, sandbox manager. Gemini uses `Config` as the concrete implementation, but the interface itself is useful.
- Separate tool declaration from invocation. Gemini has `DeclarativeTool`/`ToolBuilder` for schema and validation, then `ToolInvocation` for one validated call.
- Treat tool execution as a state machine. Gemini’s scheduler has statuses like validating, awaiting approval, scheduled, executing, success, error, cancelled.
- Use a confirmation bus, not direct UI callbacks.
- Normalize model-provider access behind a minimal `ContentGenerator`: generate, stream, count tokens, embeddings.
- Persist sessions as append-friendly records. Gemini’s JSONL recorder supports metadata updates, messages, tool calls, rewind, summaries, and resume.
- Provide an SDK facade that hides core complexity.

## Tradeoffs Gemini Makes

- It has at least two runtime generations: legacy `GeminiClient`/`Turn` stream events and newer `AgentProtocol`/`AgentEvent`, bridged by translators.
- `Config` is a large service locator and also implements `AgentLoopContext`.
- There are multiple event planes: agent events, legacy Gemini stream events, message bus events, global `coreEvents`, OpenTelemetry logs/spans, and context traces.
- Policy is rich: rules by tool, MCP server, args pattern, annotations, approval mode, interactivity, subagent.
- Subagents are isolated through cloned registries and derived message buses, and they cannot recursively call agent tools.
- SDK ergonomics are good, but safety defaults look embedding-oriented.

## Recommendations For turnturn v1

- Start with one canonical event model: `session.created/updated`, `turn.started/ended`, `message.delta/final`, `tool.requested/updated/completed`, `approval.requested/resolved`, `error`, `usage`.
- Define `AgentLoopContext` as a dependency bag, but do not let the whole config object become the runtime god object.
- Adopt the `ToolDefinition -> ToolInvocation -> Scheduler` split.
- Make approvals first-class and serializable from day one.
- Keep provider boundaries stricter than Gemini.
- Use append-only session/event logs as the source of truth for resume.
- Implement policy v1 narrowly.
- Include subagent identity in the event model and policy model now, even if subagents are minimal in v1.
- Ship a tiny SDK facade early.

## Risks If Copied Too Literally

- Provider lock-in.
- Too many event systems too early.
- A service-locator `Config` can make tests and embedding APIs harder than needed.
- Callback-based confirmation details create migration pain once remote/headless clients need serializable approvals.
- Rich policy matching can become an attractive nuisance before turnturn has enough real-world cases.
- Carrying both legacy and new session abstractions would slow v1.

