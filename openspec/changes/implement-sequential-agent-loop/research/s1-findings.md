# S1 — Provider Stream Capture Findings

Date: 2026-09-09 (revised 2026-09-10)
Status: harness verified and fixed; live provider capture blocked on this host.

**S1 no longer blocks Milestone 3.** Decided 2026-09-10: the engine loop is
built against the scripted provider and the `ProviderPort` in `../design.md`, and the
Anthropic adapter is written when fixtures exist. The risk accepted is that the
port may need revision once real streams are observed — bounded, because only
the adapter and the conformance suite depend on the port's event vocabulary, and
neither is built until fixtures land.

## Harness result

`scripts/capture-provider-streams.py` is a Python 3.9 standard-library
recording proxy. It forwards requests to a configured HTTPS upstream and
streams the response to the client, flushing each write while teeing exactly
those bytes to `response.sse`.

### Correction, 2026-09-10: the first version buffered the whole stream

The original implementation called `response.read(chunk_size)`.
`http.client.HTTPResponse.read(n)` blocks until it has **n** bytes or EOF, so
whenever provider events are smaller than `chunk_size` — which is always — the
proxy delivered nothing until the upstream connection closed.

Measured against a local SSE upstream writing three events 0.6s apart:

| Path | Event arrival |
| --- | --- |
| Direct to upstream (baseline) | +0.00s, +0.61s, +1.21s |
| Through proxy, `read()`, chunk 1024 | nothing until +1.82s, then all at once |
| Through proxy, `read()`, chunk 1 | +0.00s, +0.61s, +1.21s (byte at a time) |
| Through proxy, `read1()`, chunk 1024 | +0.00s, +0.61s, +1.21s |

Fixed by using `read1()`, which returns whatever one underlying read yields.
Delivery now matches the baseline at the default chunk size, and `response.sse`
holds the exact upstream bytes.

This is worth recording rather than quietly fixing: it is invisible to a smoke
test that only checks whether bytes eventually arrive, and it would have
corrupted every fixture's delta boundaries while making the driving agent
appear to hang.

A second fix: on a mid-stream upstream failure the handler called `send_error`
after headers had already been sent, injecting a second header block into the
response body and corrupting the capture. It now only sends an error response
when no status line has gone out, and otherwise closes the connection.

The script preserves request bodies and response headers verbatim, as directed.
`CAPTURE_CASE=truncated-tool-json` rewrites `max_tokens` or
`max_output_tokens` to 48. Other case values select their fixture directory
without altering the request. The proxy records a request body, raw response
bytes, status, headers, duration, method, path, upstream, and rewrite result.

## Live-capture blocker

The available Codex CLI is authenticated through ChatGPT, not an OpenAI API
key. Configuring a custom `model_provider` therefore omits an `Authorization`
header and `api.openai.com` returns HTTP 401. Repointing its ChatGPT base URL
to the proxy preserves its login but routes auxiliary ChatGPT service calls
through it as well; those calls receive Cloudflare 403 responses. The Claude
Code executable is not installed (only the Claude desktop app is present).

No failed or auxiliary responses were retained as fixtures. There are no
recorded provider stream fixtures in this change, and nothing here should be
read as an observation of real provider behavior. The capture matrix below must
be run before the adapter is implemented.

Confirmed independently on 2026-09-10: neither `claude` nor `codex` is on
`PATH`, and there is no `node`/`npm` with which to install the Claude Code CLI.
`fixtures/` is empty; the only fixture path referenced anywhere is a stale
editor tab pointing at a deleted file.

### Two ways to unblock

1. **API key plus `curl`** — fastest, and it removes the agent from the loop
   entirely. The driving agent was only ever a way to avoid holding a key; a
   hand-written request body carrying one tool definition produces the
   `interleaved`, `truncated-tool-json`, and `context-limit` fixtures directly,
   with exact control over `max_tokens` and no unrelated auxiliary traffic.
2. **Install node, then the Claude Code CLI**, and run it with
   `ANTHROPIC_BASE_URL` pointed at the proxy. No key needed, but node is a
   prerequisite the repo needs regardless.

Path 1 is recommended for S1. Path 2 remains the only route to fixtures that
reflect a real agent's request shape, which is a separate and lower-priority
question than stream mechanics.

Fixtures are recorded verbatim by design; scrubbing was considered and
deliberately dropped as not worth the complexity for a local throwaway harness.

## Capture matrix for the next run

| Provider | Required runs |
| --- | --- |
| Anthropic | `interleaved`, `truncated-tool-json`, `context-limit`, and a natural or explicitly synthetic `refusal` |
| OpenAI | `interleaved` and `truncated-tool-json`; add context-limit/refusal when available |

For each accepted fixture, the findings must state the exact event sequence,
the byte/event at which each tool argument buffer becomes parseable, and each
terminal reason. This document deliberately does not invent that evidence.

## Port Design

Moved to `../design.md`, Decision 2, which is the single home for it. This file
records only what the capture harness did and did not establish.
