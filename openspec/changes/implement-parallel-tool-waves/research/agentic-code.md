# Claude Code Reference: Cancellation Boundaries

Snapshot: `../claude-code` at `ac3cf58` (2026-09-23 inspection). This repo's historical `agentic-code` filename denotes the Claude Code reference; `openspec/project.md` preserves that gate name.

- `src/services/tools/StreamingToolExecutor.ts:36-66` distinguishes concurrent-safe calls from exclusive ones and uses a child abort controller, rather than treating every tool as independent.
- `src/services/tools/StreamingToolExecutor.ts:263-383` tracks per-tool results and can cascade a sibling error through its sibling abort controller.

Borrow explicit parent/child cancellation reasoning and per-call terminal tracking. Deliberately **do not** copy sibling-error cascade: Rishabh wants a recoverable failure or timeout of one read to leave another read's outcome intact. Turn-wide policy abort and user cancellation remain separate cases.
