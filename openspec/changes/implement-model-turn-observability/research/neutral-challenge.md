# Neutral Challenge: Model-Turn Observability

This change alters a public engine/provider composition boundary. The following objections must be resolved before implementation.

## 1. Is an observation port actually necessary?

A wrapper around `ProviderPort` can already see semantic `ProviderRequest` and normalized `ProviderEvent` values. An injected HTTP client can see the serialized request. Could tests and local logging combine those without adding a public port?

Burden of proof: demonstrate why exact wire evidence and runtime provenance need one correlated contract rather than two private loggers joined after the fact.

## 2. Are raw SSE frames worth their storage and exposure risk?

Completed response items plus normalized events may explain most failures. Raw frames increase volume and preserve partial content that ordinary history might never retain.

Burden of proof: name failures that cannot be diagnosed from completed semantic chunks and normalized events, and establish a bound that preserves those cases.

## 3. Does a custom trace format duplicate OpenTelemetry?

Gemini uses OTel spans and mature viewers. A custom writer, reducer, API, and UI creates maintenance work.

Burden of proof: identify the model-visible provenance and local replay properties OTel does not provide cleanly, and leave a future export path rather than creating an island.

## 4. Is “best effort” hiding failures we should test?

If every trace error is swallowed, observability can silently disappear exactly when needed.

Burden of proof: define how writer degradation becomes visible to the operator without changing engine behavior.

## 5. Is per-attempt tracing premature before retry is complete?

The current adapter does not yet have the full retry/backoff path. Attempt identity may overdesign the first implementation.

Burden of proof: show that the data model would be wrong or require migration if it started at step identity and added attempts later.

## 6. Are context token estimates misleading?

Provider tokenizers and gateway transformations can differ from local estimates. A precise-looking category total may be treated as billing truth.

Burden of proof: clearly separate estimates from authoritative provider usage and test that categories do not overlap.

## 7. Could trace capture affect latency or memory?

Serializing a full request twice and retaining raw stream frames can add work on the hot path.

Burden of proof: avoid unbounded in-memory accumulation, keep payload writes incremental where possible, and add a measured overhead check before enabling capture by default.

## 8. Is this the right priority before finishing the product UI?

The coding-chat workspace still lacks rich Markdown, grouped tool cards, stop/retry, and several recovery states.

Burden of proof: keep the first vertical slice narrow enough to improve current dogfooding rather than becoming a general tracing platform.

## 9. What happens when traces contain sensitive repository material?

Excluding credentials does not make prompts, source code, paths, and tool output non-sensitive.

Burden of proof: local-only defaults, explicit enablement/visibility, deletion semantics, and a clear warning are required. “No credentials” is not equivalent to “safe to share.”

## 10. Why not use the earlier capture proxy?

The proxy already records complete provider HTTP traffic without touching engine contracts.

Burden of proof: explain which semantic and runtime facts the proxy cannot observe, and retain the proxy only for provider conformance fixtures rather than creating two competing product trace paths.
