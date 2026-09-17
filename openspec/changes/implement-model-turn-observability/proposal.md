# Proposal: Model-Turn Observability

Companion change to Milestone 3.5. The roadmap owns milestone order and exit criteria; `design.md` owns the proposed architecture; `tasks.md` owns implementation order.

## Why

The product client can now run a real conversation, stream assistant text, recover durable state after reload, and resolve approvals. It still cannot explain a model turn.

The failure that exposed this gap was simple: the model claimed that it had no tools and no repository access. The runtime endpoint proved that tools existed, but none of the current surfaces could show, for that particular provider attempt:

- the model-visible messages assembled from durable history;
- the tool definitions offered to the model;
- the exact OpenAI-compatible request body sent to LiteLLM or Ollama;
- the raw stream frames and normalized provider events received in return;
- which tool outputs were executed, and whether they appeared in a later model request;
- future context contributions such as instructions, compaction, and memory.

`GET /api/debug/state` answers a different question: whether the durable engine and provider-history reducers accept a session log. Durable records are product truth, not a complete inference trace. Expanding that endpoint into an ad hoc dump would couple four truths again: conversation state, provider wire evidence, runtime execution, and operational metrics.

## What Changes

- Add an opt-in, local diagnostic trace path independent of durable conversation records and ordinary telemetry.
- Observe each concrete provider attempt, including retries, rather than treating a turn as one opaque request.
- Preserve both a provider-neutral model-context snapshot and the exact serialized provider request body.
- Record raw provider stream evidence, normalized `ProviderEvent` output, and the terminal provider outcome without making trace failure affect the turn.
- Record tool validation, policy, approval, execution, result, and the later model-visible consumption of that result as separate facts.
- Reduce ordered raw observations into a semantic trace view with provenance links.
- Expose conversation/session-scoped, read-only trace APIs with lazy payload loading.
- Add an on-demand per-turn inspector to developer mode with Context, Request, Response, Tools, and Runtime views.
- Add a Gemini-style context contribution breakdown for system instructions, tools, conversation history, tool interactions, workspace instructions, compaction, and future memory.

## Capabilities

### New Capabilities

- `model-turn-observability`: local diagnostic capture, reduction, retrieval, and inspection of model-visible context, provider attempts, provider response streams, and tool/runtime provenance.

### Modified Capabilities

None. `openspec/specs/` has no accepted model-turn trace contract yet. This change complements the in-flight developer-mode requirement in `implement-coding-chat-workspace`; it does not redefine durable conversation state.

## Impact

**Contract gate: full.** The implementation needs an optional observation handle at the engine/provider boundary so the adapter can expose the exact body it sends while the engine correlates that body with turn, step, retry, and tool activity. That alters a public package boundary, though it does not alter `packages/protocol` or the durable record format. The neutral challenge and synthesis artifacts are therefore required before implementation.

**Storage.** Trace bundles are diagnostic sidecars, not session logs. They may contain prompts, model responses, source paths, tool input, and tool output. They remain local, opt-in, and deletable without affecting conversation replay.

**Server and client.** The server gains read-only trace retrieval. The React client gains an on-demand inspector; the normal transcript remains unchanged.

**Not in this change.** Remote trace upload, hosted analytics, arbitrary request-header capture, billing dashboards, cross-session memory, a generic OpenTelemetry platform, or making trace data a prerequisite for engine correctness.
