# Synthesis

Status: complete

This file captures the main-agent grilling phase after raw reference research and neutral challenge.

## Inputs

- `research/codex.md`
- `research/gemini-cli.md`
- `research/agentic-code.md`
- `research/neutral-challenge.md`

## Resolved Questions

### Is the boundary map too broad for v1?

Yes. The boundary map is useful as curriculum, but not every named boundary should become a v1 implementation surface.

Conclusion: Milestone 1 should harden only the minimum enforceable boundaries: protocol/event log, provider adapter, tool executor, approval policy, and in-process transport serialization.

### Should v1 implement only in-process transport, or a local app/session server as well?

v1 should implement only in-process transport, but every command/event must pass through JSON serialization fixtures. This preserves speed while forcing transport discipline.

Conclusion: local HTTP/SSE/WebSocket remains a designed future adapter, not v1 implementation.

### Which pieces belong in protocol before engine scaffolding starts?

Protocol must define event identity, schema versioning, durable vs ephemeral classification, parent/causal IDs, turn/tool state transitions, approval commands, cancellation commands, and replay ordering.

Conclusion: protocol/event-log work moves ahead of engine scaffolding.

### What is the minimum executor boundary that avoids coupling without overbuilding sandbox infrastructure?

The executor boundary must cover cwd, environment, timeout, cancellation, bounded output, and exit status. It should not include full sandbox parity or remote execution in v1.

Conclusion: implement local executor only, behind an interface.

### Are memory and subagent boundaries sufficiently deferred?

The previous draft still named them too prominently. They should not have implementation interfaces in v1 unless protocol fields are needed for future lineage.

Conclusion: keep optional lineage fields in protocol discussion, but defer memory/subagent implementation.

## Final Synthesis

The validated course is a narrowed version of the original path:

- Codex remains the conceptual guide for session/turn/step and replay discipline.
- Gemini CLI remains the guide for TypeScript SDK ergonomics and typed tool interfaces.
- agentic-code remains the guide for operational invariants, especially `tool_use`/`tool_result`.
- The neutral challenge changes the sequencing: protocol/event-log contracts must be hardened before engine implementation.

## Go / No-Go

Conditional go for architecture direction.

No-go for engine implementation until:

- protocol/event contract is explicit
- serialization round-trip fixture exists
- replay fixture exists
- tool-use/tool-result state machine is specified
- approval/cancellation semantics are specified
- non-v1 boundaries are explicitly deferred

## Recommended Next OpenSpec Work

Create or update the next milestone around protocol/event-log contracts before engine scaffolding.
