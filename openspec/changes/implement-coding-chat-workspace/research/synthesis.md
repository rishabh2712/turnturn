# Synthesis: provider/model catalog discovery

Date: 2026-09-20

## Decision

Proceed with D30 as an additive extension to the already implemented D28/D29 model-switching path. The implementation is a server-owned provider registry plus bounded model discovery, a safe public catalog route, additive client transport methods, and a grouped picker. The existing configured profile list remains the fallback and the source of truth for profiles that discovery cannot verify.

## Evidence reconciled

1. Anthropic's Models API can list models available to the authenticated account, so direct Anthropic options need not be hardcoded.
2. LiteLLM's model list is a gateway view. It identifies names routable by that connection but does not prove the upstream model brand or native wire format. The configured connection remains authoritative.
3. Ollama exposes local tags and model metadata, including capabilities. This supports a better compatibility label but not a universal tool conformance guarantee.
4. Turnturn already has server-owned profile activation and Keychain-backed credentials. Reusing those boundaries avoids a second secret/configuration path.
5. The existing client transport and session store already model profile identity. Adding discovery should not alter durable protocol records or rewrite old sessions.

## Rejected alternatives

- **Hardcode every provider's model list.** Stale quickly and cannot reflect account-specific LiteLLM or local Ollama availability.
- **Let the browser call provider model endpoints.** Leaks credentials or requires moving credentials to an unsafe client boundary.
- **Infer provider from model prefixes.** Wrong for LiteLLM, Bedrock, custom deployment names, and aliases.
- **Make discovery mandatory before server startup.** One unavailable provider would make unrelated providers unusable.
- **Treat every discovered model as tool-capable.** Discovery is not a conformance suite; capability uncertainty must remain visible.
- **Persist a discovery cache to disk.** Adds another durable state format and stale-data migration before the product needs it.
- **Replace D28 session switching with in-place mutation.** An active engine and its provider history are session-bound; mutating them would violate the existing lifecycle invariant.

## Contract and risk boundary

The new HTTP and transport methods are additive public APIs, so tests must prove old runtime/model responses remain usable and no protocol package changes are needed. A model profile id must be deterministic and connection-scoped. If a provider removes a model, replay stays available and only new invocation is blocked. The one-way risk is exposing a catalog DTO that accidentally contains private connection data; the leak tests in task 5.4c.0 are therefore a prerequisite, not cleanup.

## Open questions intentionally deferred

- Whether to add provider health polling beyond explicit refresh.
- Whether to rank models by context window or cost.
- Whether to verify unknown tool support with a paid or local probe.
- Whether to persist user-pinned model ordering.

Each can be added later without changing the core provider/connection/model distinction or the session boundary.
