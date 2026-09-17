# Research Index: Model-Turn Observability

Date: 2026-09-15

Each fact has one detailed owner:

- `user-interview.md` — the dogfood failure, requested viewer, and interaction boundary.
- `codex.md` — local rollout evidence, provenance reduction, attempt identity, and non-interference.
- `gemini-cli.md` — central model-call instrumentation, context breakdown, request export, and tool spans.
- `agentic-code.md` — Claude Code debug logging, operational bounds, and limitations of the available reference.
- `neutral-challenge.md` — objections the design must answer.
- `synthesis.md` — proposed dispositions and remaining choices.

The current Turnturn integration points were verified in:

- `packages/assistant-core/src/provider-step-runner.ts`
- `packages/assistant-core/src/tool-wave-runner.ts`
- `packages/assistant-core/src/providers/openai-chat-completions/request.ts`
- `packages/assistant-core/src/providers/openai-chat-completions/http.ts`
- `packages/assistant-core/src/providers/openai-chat-completions/adapter.ts`
- `packages/assistant-server/src/api/read-only.ts`

The existing `/api/debug/state` endpoint remains a reducer-health check. It is not widened into the trace API.
