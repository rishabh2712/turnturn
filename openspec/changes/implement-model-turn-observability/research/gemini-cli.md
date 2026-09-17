# Gemini CLI Research: Context Explanation and Instrumentation

Revision: `ed2ac40df67a319bf348bd7e3d10494696b31b38`

## Files inspected

- `../gemini-cli/packages/core/src/core/loggingContentGenerator.ts`
- `../gemini-cli/packages/core/src/core/recordingContentGenerator.ts`
- `../gemini-cli/packages/core/src/scheduler/tool-executor.ts`
- `../gemini-cli/packages/core/src/services/chatRecordingService.ts`
- `../gemini-cli/packages/core/src/telemetry/types.ts`
- `../gemini-cli/packages/core/src/telemetry/loggers.ts`
- `../gemini-cli/packages/cli/src/ui/commands/chatCommand.ts`
- `../gemini-cli/docs/local-development.md`

## Findings

`LoggingContentGenerator` decorates the content generator at one central boundary. It records model calls with prompt correlation, request contents, generation configuration, system instructions, tool definitions, endpoint metadata, response candidates, usage, duration, and classified errors.

It computes a non-overlapping context breakdown for system instructions, tool definitions, ordinary history, per-tool interactions, and MCP servers. Provider usage remains separate from those local estimates.

The CLI's `/debug` action exports the latest constructed API request after conversion to its REST payload. `/stats` is a different surface for session, model, and tool aggregates. This validates the need for both exact evidence and a semantic summary.

`ToolExecutor` wraps execution in a correlated trace span containing tool name, call ID, description, input, result, duration, and error. UI telemetry separately aggregates tool success, failure, decision, and duration. `ChatRecordingService` enriches recorded calls with display metadata. `RecordingContentGenerator` retains generated response chunks for deterministic fake-response replay.

Gemini supports external viewing through OpenTelemetry with Genkit, Jaeger, or Google Cloud.

## Applied to Turnturn

- Instrument a central model-call boundary.
- Present system instructions, tool definitions, history, and tool interactions as separate context contributions.
- Provide an exact request view and an aggregate/semantic view; do not combine them into one dump.
- Correlate tools and provider calls by stable IDs.
- Retain response chunks for replayable adapter tests.

## Deliberate difference

Turnturn does not adopt OpenTelemetry as its local evidence contract. OTel can become an export later, while the local reducer defines model-visible provenance deterministically.
