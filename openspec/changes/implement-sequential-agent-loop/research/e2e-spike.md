# E2E Spike Findings

Date: 2026-09-11
Runner: `packages/assistant-core/scripts/e2e-turn.mjs`

First time the real adapter, real workspace tools, real policy, and the real engine loop have run in the same process. Every prior test exercised them in isolation.

## What the spike proved

Composition works. Against a deliberately refused endpoint (`http://127.0.0.1:1`):

```text
turn turn_c90c1f49  started
turn turn_c90c1f49  failed     fetch failed
outcome   accepted
turn      failed
records   6
issues    none
```

Three things worth having verified, none of which any isolated test covers:

- The four components wire together with no missing or mismatched port.
- A transport failure reaches a **terminal turn state** rather than hanging — the first mechanical v1 gate.
- `reduceEngineState(records).issues` is **empty** on the failure path. The engine emitted a record sequence the protocol considers legal even while failing.

No credentials were needed for this. A refused connection exercises the whole composition and the failure path.

## Finding 1: transport failures are not classified

`fetch` in `providers/openai-chat-completions.ts` is not wrapped. A network failure throws out of the async generator as a raw `TypeError: fetch failed` instead of being yielded as a `ProviderEvent`.

Consequences:

- It violates Decision 2 — *nothing provider-shaped escapes the port.* A raw Node error crosses the boundary, and the durable `turn.failed` record carries the message `fetch failed`.
- **`retryable` is lost.** B12 retries only before the first emitted event, and a connection failure before any event is precisely that case. The engine cannot know it may retry, so it never will.
- `ProviderFailure.kind` is lost, so Milestone 5 cannot distinguish `context-limit` from a generic failure once that path is live.

The engine degrades gracefully — it catches the throw and writes a terminal record — so this is a correctness gap in classification, not a crash. That is also why 38 isolated tests did not catch it: the adapter tests feed bytes to the parser and never exercise the fetch, and the loop tests use the scripted provider which never fetches.

Fix: wrap the request in `try`/`catch` and yield `{ type: "failed", error: { kind: "transport", retryable: true, message } }`. While there, confirm non-2xx responses are classified too — a 429 must be `retryable: true` and a 400 `retryable: false`, which B12 and the T4 task list already require and which the same missing guard may cover.

## Not yet run

A turn against a live model through the LiteLLM lane, with tools executing and an approval prompt. That needs credentials. The approval path in the runner — resolving through a concurrent `engine.submit` while `turn.submit` is in flight, the first real exercise of B8 — is therefore still unproven.
