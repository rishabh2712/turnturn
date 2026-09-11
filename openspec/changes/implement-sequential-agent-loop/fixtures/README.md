# Provider stream capture

Fixtures are no longer an adapter implementation gate. Build provider adapters
live-first when credentials or local models are available, then use captured
streams as regression/conformance evidence.

The intent of this directory is to preserve observed wire streams so parser
tests can later run without network, credentials, or model nondeterminism.

Model brand does not define adapter truth. Wire format does.

The capture path is:

```text
Claude Code CLI / Codex CLI
        |
        | provider base URL = http://127.0.0.1:8765, or curl/test driver
        v
scripts/capture-provider-streams.py
        |
        | HTTPS upstream, original credentials forwarded
        v
Anthropic / OpenAI API
```

The proxy is plain HTTP locally and TLS only from proxy to the upstream provider,
so no local MITM certificate is needed.

## Capture proxy

Run from the change directory:

```bash
CAPTURE_PROVIDER=anthropic \
CAPTURE_CASE=interleaved \
CAPTURE_UPSTREAM_BASE_URL=https://api.anthropic.com \
python3 scripts/capture-provider-streams.py
```

The proxy listens on `http://127.0.0.1:8765` by default and writes captures to:

```text
fixtures/providers/<provider>/<case>/<timestamp>/
  request.body
  request.json
  response.sse
  meta.json
```

`request.body` is recorded as fixture data. Credential-bearing request/response
headers such as `Authorization`, cookies, API-key headers, and token-like
headers are forwarded upstream but redacted from saved JSON metadata.

For truncated-tool cases, the proxy rewrites JSON request bodies by lowering
`max_tokens` or `max_output_tokens` to `48` unless overridden:

```bash
CAPTURE_CASE=truncated-tool-json \
CAPTURE_FORCE_MAX_TOKENS=50 \
...
```

## Optional: Claude Code → Anthropic

Install/use Claude Code, then point its Anthropic base URL at the proxy. The
expected environment variable is:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8765
```

Current host note, 2026-09-11: `claude` is not on `PATH`, but Claude Code is
installed as the VS Code extension native binary:

```text
/Users/rishabhbansal/.vscode/extensions/anthropic.claude-code-2.1.267-darwin-arm64/resources/native-binary/claude
```

`claude --version` reports `2.1.267 (Claude Code)`. Use `--bare --print` for
fixture runs so auth is API-key/settings based and unrelated desktop/keychain
traffic is minimized.

Run one small prompt per captured case. The prompt should be self-authored and
minimal; the capture needs stream mechanics, not a valuable prompt corpus.

Useful Anthropic cases:

- `interleaved`
- `truncated-tool-json`
- `context-limit`
- `refusal`; if this cannot be forced benignly, synthesize from observed
  grammar and set `synthetic: true` in `meta.json`

## Optional: Codex CLI → OpenAI

Point Codex's OpenAI/Responses base URL at the proxy via a temporary configured
model provider. Use an API-key auth path for this capture run; ChatGPT-login
traffic can include auxiliary backend calls that are not provider stream
captures.

Proxy run:

```bash
CAPTURE_PROVIDER=openai \
CAPTURE_CASE=interleaved \
CAPTURE_UPSTREAM_BASE_URL=https://api.openai.com/v1 \
python3 scripts/capture-provider-streams.py
```

Temporary Codex invocation shape:

```bash
OPENAI_API_KEY=... \
codex exec \
  --ignore-user-config \
  -c model_provider=\"capture-openai\" \
  -c model=\"gpt-5.1-codex\" \
  -c 'model_providers.capture-openai={name="capture-openai",base_url="http://127.0.0.1:8765",env_key="OPENAI_API_KEY",wire_api="responses"}' \
  -C /path/to/small/test/repo \
  "Use a tool in a tiny way so the stream includes tool mechanics."
```

Verify the proxy receives `/responses` before accepting the capture. If the
installed Codex build rejects the inline provider table, put the same
`model_provider` and `[model_providers.capture-openai]` values in a temporary
profile config and run with `--profile`.

Useful OpenAI cases:

- `interleaved`
- `truncated-tool-json`

## LiteLLM gateway → OpenAI-compatible streams

Use the company LiteLLM gateway as a live adapter lane and as an easy capture
source. This captures OpenAI-compatible `/v1/chat/completions` SSE streams
first; treat these as LiteLLM/OpenAI-compatible captures unless the gateway
exposes an Anthropic passthrough route and the captured bytes prove the
Anthropic grammar.

Do not paste keys into commands. Export a fresh key in the shell:

```bash
export LITELLM_BASE_URL=https://litellm.test.asapp.com
export LITELLM_API_KEY=...
```

List available models:

```bash
scripts/litellm-capture-smoke.sh models
```

Pick one returned model and verify streaming directly:

```bash
export LITELLM_MODEL=...
scripts/litellm-capture-smoke.sh direct
```

Then capture the same stream through the proxy:

```bash
CAPTURE_CASE=litellm-openai-chat-smoke \
scripts/litellm-capture-smoke.sh proxy
```

The proxy writes:

```text
fixtures/providers/litellm/<case>/<timestamp>/
  request.body
  request.json
  response.sse
  meta.json
```

The saved JSON metadata redacts credential-bearing headers. The raw request
body and raw upstream SSE response are fixture data.

## Acceptance criteria for saved captures

For each accepted fixture:

- `response.sse` contains the exact upstream streaming bytes.
- `meta.json` records status, headers, duration, provider, case, and whether
  the fixture is synthetic.
- `request.json` records whether token-limit rewriting was applied.
- Credential-bearing headers are not persisted; the capture should be reusable
  for parser/conformance tests without containing auth material.
- The corresponding notes in `research/s1-findings.md` state:
  - the observed event sequence;
  - the byte/event where each tool argument buffer becomes parseable;
  - the terminal reason.
