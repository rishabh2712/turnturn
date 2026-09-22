# Neutral challenge: provider/model catalog discovery

Date: 2026-09-20

This challenge tests D30 and task 5.4c before implementation. It is intentionally skeptical; the implementation agent must resolve these points with tests, not by weakening the observable requirements.

## Challenge 1: Is discovery worth the new boundary?

The current static catalog already switches providers safely. A registry, discovery coordinator, public route, transport methods, cache state, and grouped picker add a substantial surface. If discovery is unreliable, a simple configured list may be more honest.

**Resolution required:** keep the static configured profiles as the availability floor. Discovery is an augmentation and refresh experience, not a startup prerequisite. If all discovery code is removed, the existing static selector must still pass. This makes the investment reversible and prevents a provider outage from disabling the app.

## Challenge 2: Can a model list prove a model is safe for agent tools?

No. Anthropic and LiteLLM model lists establish account visibility; Ollama metadata may expose capabilities, but a capability label is not a conformance run. Showing every listed model as tool-capable would turn discovery into a false promise.

**Resolution required:** expose `supported`, `unsupported`, and `unknown`. Only an explicit provider capability can produce `supported`; lack of capability produces `unknown` unless the provider explicitly says unsupported. The picker disables only `unsupported`, warns on `unknown`, and the provider conformance suite remains the authority for stream/tool correctness.

## Challenge 3: What happens when a model disappears?

If `ModelCatalog.require()` only accepts the newest discovery snapshot, old sessions become unreadable after a provider renames, retires, or temporarily hides a model. That would make discovery destroy history.

**Resolution required:** persist and resolve deterministic profile identity from the saved connection identity and model id. A missing current listing affects only availability for a new invocation; it does not prevent transcript replay. Add a restart-style test before marking the task complete.

## Challenge 4: Does “provider” mean brand, wire, or connection?

LiteLLM can expose Claude or Bedrock routes through an OpenAI-compatible endpoint. Treating a model prefix as Anthropic would select the wrong adapter and produce misleading traces.

**Resolution required:** connection identity owns credentials, endpoint, and adapter. Wire identity is explicit. Model names are opaque strings. A Claude-named LiteLLM entry must remain LiteLLM in the public catalog and construct the configured OpenAI-compatible adapter.

## Challenge 5: Is a refresh route a secret exfiltration path?

Discovery errors often contain URLs, proxy response bodies, request ids, or authorization hints. A convenience `GET /providers` can also accidentally serialize private config if it reuses internal objects.

**Resolution required:** define a separate public DTO and fixed error codes. Test serialized output against sentinel keys, helper paths, headers, query values, and complete endpoint URLs. Refresh requires the existing server mutation token. No browser-supplied URL, header, or credential is accepted.

## Challenge 6: Can refresh results race?

Two refreshes can complete out of order. Publishing the older result last would make the picker move backward and could activate a profile that the UI no longer shows.

**Resolution required:** assign a generation when refresh begins and publish only the newest generation. Test reverse-order completion with deterministic deferred fetches.

## Challenge 7: Is a public transport API alteration justified?

`ChatTransport.listProviders()` and `refreshProviders()` expand the client/server contract. Existing clients should continue to work while the new UI rolls out.

**Resolution required:** retain `/api/runtime.models` as a projection during this change, keep transport additions additive, and make the picker fall back to that projection if the provider route is unavailable. Do not change protocol package types.

## Challenge 8: What is deliberately not solved?

Dynamic pricing, context-window ranking, model quality scoring, downloads, provider editing, and cross-provider history translation would turn a catalog into a model-management product.

**Resolution required:** leave them out. A model option is a selectable server-owned profile, not a promise about quality or a request to migrate history.
