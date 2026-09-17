# Claude Code Research: Debugging and Operational Bounds

Reference repository revision: `ac3cf582b28d68eb661c8ee1f748e9d4cb47265e`

The local reference is the repository named `../claude-code`; the gate keeps the historical filename `agentic-code.md` as required by `openspec/project.md`.

## Files inspected

- `../claude-code/src/utils/debug.ts`
- `../claude-code/src/skills/bundled/debug.ts`
- `../claude-code/src/services/analytics/metadata.ts`
- `../claude-code/src/QueryEngine.ts`
- `../claude-code/src/query.ts`
- `../claude-code/src/commands/ctx_viz/index.js`
- `../claude-code/src/commands/debug-tool-call/index.js`

## Findings

Claude Code's public debug path is opt-in for ordinary users through `--debug`, a debug file, or the `/debug` skill. The debug skill reads only a bounded tail—64 KiB, then the last 20 lines—because logs can grow without bound and reading them fully spikes memory.

Its debug writer buffers ordinary writes and has an immediate path when explicit debug mode is active. Writes and cleanup are treated as operational support rather than conversation truth.

Tool telemetry is independently bounded: nested input is truncated by depth and collection size, internal marker keys are excluded, and tool details require explicit enablement. This reinforces the distinction between rich local evidence and externally consumable telemetry.

`QueryEngine` persists accepted user messages before awaiting the API response so an interrupted request remains resumable and debuggable. The conversation transcript remains operationally authoritative for resume, while debug logs are supplemental.

The checked-in `/ctx_viz` and `/debug-tool-call` modules in this reference are disabled stubs, so this repository does not provide a complete context-viewer implementation that Turnturn can copy. That limitation is recorded rather than inferred around.

## Applied to Turnturn

- Keep diagnostic storage supplemental to durable conversation truth.
- Bound high-volume debug evidence and make truncation explicit.
- Make enablement visible and local.
- Preserve accepted input durably before relying on provider completion; Turnturn already follows the equivalent durable-first rule.

## Not copied

- Plain text debug logs as the semantic trace contract.
- Telemetry truncation rules for exact local request bodies.
- Disabled internal command stubs as evidence of a usable viewer.
