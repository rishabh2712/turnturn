# Codex Research: Local Rollout Evidence

Revision: `73a1148c9c775c2a4616ce5096291740a00ed68a`

## Files inspected

- `../codex/codex-rs/rollout-trace/README.md`
- `../codex/codex-rs/rollout-trace/src/inference.rs`
- `../codex/codex-rs/rollout-trace/src/model/conversation.rs`
- `../codex/codex-rs/rollout-trace/src/payload.rs`
- `../codex/codex-rs/rollout-trace/src/raw_event.rs`
- `../codex/codex-rs/otel/src/events/session_telemetry.rs`

## Findings

Codex separates rollout tracing from telemetry. Rollout tracing is opt-in and local, and its bundles may contain prompts, responses, tool input/output, terminal output, and paths. Operational telemetry has a separate aggregation path.

The rollout trace hot path writes an ordered raw event spine and heavyweight payload references. A deterministic replay builds a semantic graph containing model-visible conversation, inference calls, tool calls, terminal work, compaction, and interaction edges. Runtime evidence is not automatically considered model-visible.

`InferenceTraceContext` is no-op-capable. Each concrete retry/fallback starts an `InferenceTraceAttempt`; an attempt owns a terminal guard. Requests and completed or partial response items are written best-effort. Trace failure does not fail Codex.

The reduced `InferenceCall` retains provider/model, response IDs, request item IDs, output item IDs, tool calls started by the response, usage, and references to full request/response payloads. `ConversationItem.produced_by` carries explicit provenance.

## Applied to Turnturn

- Separate diagnostic traces from durable session records and telemetry.
- Trace concrete attempts, not only turns or steps.
- Append evidence first and reduce later.
- Preserve links between model-visible items and runtime objects.
- Make the observer no-op-capable, terminal-guarded, and best-effort.

## Deliberate difference

Codex currently records completed output items rather than every raw stream delta in this trace path. Turnturn's active problem includes stream grammar and translation, so the proposal preserves bounded raw frames in addition to completed semantic output.
