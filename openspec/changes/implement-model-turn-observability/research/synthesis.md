# Synthesis: Model-Turn Observability

Status: approved 2026-09-17.

## Accepted dispositions

| Challenge | Proposed disposition |
| --- | --- |
| Observation port necessity | Accept the concern, retain one minimal optional port. A provider wrapper cannot see pre-parser frames or exact adapter body; independent loggers cannot reliably express later tool-result consumption without shared attempt identity. Validate the final API surface before implementation. |
| Raw frame value | Accept with a hard bound. The truncated-tool-arguments and contradictory finish-reason cases occur below normalized completion and require frame evidence. Add explicit truncation metadata. |
| OTel duplication | Reject OTel as the primary local truth, accept it as a future export. OTel spans do not by themselves define deterministic model-visible replay or payload provenance. |
| Best-effort silence | Accept. Trace degradation must appear in trace health/process logs and the inspector, while remaining unable to alter the turn. |
| Per-attempt timing | Reject deferral. Attempt identity is cheap now and migration-prone later; transport retry and fallback are already part of the intended provider contract. |
| Token estimate precision | Accept. Label category numbers estimates, keep them additive, and show authoritative provider totals separately. |
| Hot-path overhead | Accept. Stream payloads incrementally, bound raw evidence, benchmark enabled/disabled runs, and do not default-enable until measured. |
| Priority | Accept. Implement only the vertical chain needed to explain one real LiteLLM/Ollama tool turn; external export and general telemetry remain out of scope. |
| Sensitive content | Accept. Local-only, opt-in, explicit warning, scoped API, and deletion independent of conversation state. Trace bundles must never be presented as share-safe. |
| Proxy alternative | Reject as product observability, retain for conformance capture. A proxy cannot know durable scope, policy, approval, execution, or later model visibility. |

## Accepted combined decision

Build a local, opt-in trace sidecar whose hot path only records ordered evidence through a no-op-capable port. Reduce that evidence into a semantic model for a read-only, per-turn inspector. Preserve exact request bodies and bounded raw response frames, but never transport credentials or arbitrary configured headers. Keep durable records, live events, and telemetry separate.

## Resolved implementation defaults

- Raw stream evidence is bounded at 10 MiB per provider attempt.
- Local dogfood enables tracing by default; other profiles do not.
- Traces follow conversation lifetime initially.
- The first UI refetches on existing lifecycle events rather than adding trace SSE.
- Exact model-visible bodies are retained; credentials and arbitrary transport headers never enter trace storage.
