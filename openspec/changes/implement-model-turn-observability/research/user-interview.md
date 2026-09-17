# User Interview: Model-Turn Observability

Date synthesized: 2026-09-15

This records requirements stated during live Turnturn dogfooding. It is not a generic observability wish list.

## Triggering incident

In a real browser conversation, the assistant said it had no tools or repository access. The server runtime reported that workspace tools existed, but the current UI could not prove whether those definitions were present in that particular provider request. The user asked why the model lacked context and what debug surface would show exactly what had been sent.

## Explicit needs

- Trace exact request/response steps in a viewer.
- Inspect the complete context sent to one model attempt rather than infer it from the chat transcript.
- Show messages, tools, semantic/contextual contributions, and future memory separately.
- Keep the ordinary interface like a polished coding chat. Protocol timelines and raw debug data should appear only when requested.
- Use the surface for real LiteLLM and local Ollama dogfooding, not only scripted smoke tests.
- Preserve requests and responses as evidence rather than reconstructing them after the turn.

## Product interpretation

The operator should be able to select a turn and answer:

```text
Which messages were sent?
Which tools were advertised?
Which instructions or memories contributed?
What exact JSON did the provider receive?
What stream did it return?
How did the adapter interpret it?
What tool ran?
Did the next model request receive that tool result?
```

## Interaction boundary

The default transcript stays calm and user-facing. A turn-level developer inspector exposes deeper evidence on demand. The user explicitly does not want the protocol timeline or generic debug panels occupying the normal chat.

## Unresolved wording

Earlier fixture work included the instruction “don't scrub anything” and later “save the requests and response at a place as is.” The current design interprets this as preserving exact model-visible request and response bodies without a lossy post-processing scrub. It still excludes Authorization, cookies, API keys, OAuth credentials, and arbitrary transport headers before capture because those are not model context.

This interpretation must be confirmed during design review. Capturing credentials would materially expand the threat model and is not proposed.
