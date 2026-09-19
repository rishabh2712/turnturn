# Turnturn local chat

The assistant server serves the built React app and injects its own per-process browser token. You do not need a second Vite server for the first Ollama test.

From the repository root:

```bash
cd /Users/rishabhbansal/Desktop/source/turnturn
export PATH="$HOME/.local/turnturn-node-v24.21.0/bin:$HOME/.local/turnturn-bin:$PATH"
ollama list
pnpm -r build
TURNTURN_PROVIDER=ollama \
TURNTURN_MODEL='qwen3.8:27b-mlx' \
TURNTURN_BASE_URL='http://127.0.0.1:11434' \
TURNTURN_API_KEY='' \
TURNTURN_WORKSPACE="$PWD" \
TURNTURN_WEB_DIST="$PWD/apps/web/dist" \
node packages/assistant-server/dist/cli.js
```

Leave that terminal running and open [http://127.0.0.1:8787/](http://127.0.0.1:8787/). Try `Say hello in one short sentence.` The server's built-in page supplies the browser token automatically. `TURNTURN_BASE_URL` is set explicitly so a saved LiteLLM URL in `.env.local` cannot redirect this local run.

The model above is the Ollama model installed on this machine as of 2026-09-14; substitute the exact name from `ollama list` if it changes. If Ollama is not already serving on port 11434, start `ollama serve` in another terminal.

For UI development with Vite, keep the assistant server running, then start `VITE_TURNTURN_TOKEN=<token-from-server-banner> pnpm --filter @turnturn/web dev` in a second terminal. The built-page path above is simpler for end-to-end testing.

Current dogfood status: conversation creation and user-message submission were observed in the real browser. A complete local-model response and refresh/recovery remain to be verified.

## Use the saved LiteLLM configuration

The repository's ignored `.env.local` contains the gateway URL, API key, provider, and model. To switch from Ollama, stop the current Turnturn server (leave Ollama itself alone), then run from the repository root:

```bash
export PATH="$HOME/.local/turnturn-node-v24.21.0/bin:$HOME/.local/turnturn-bin:$PATH"
pnpm -r build
node packages/assistant-server/dist/cli.js
```

Refresh [http://127.0.0.1:8787/](http://127.0.0.1:8787/) after every server restart: the browser token is new each time. The configured `bedrock-claude-5-sonnet` model was listed by the LiteLLM gateway on 2026-09-14, and the gateway accepted the saved key for a read-only models request. A completed browser turn through this lane is not yet verified.

## Add direct Anthropic models without saving the key in the repository

Store the key once from the repository root. The macOS `security` program owns the hidden prompt; the setup script does not read the value:

```bash
./scripts/setup-anthropic-keychain.sh
```

Then add only the non-secret model list to the ignored `.env.local`:

```env
TURNTURN_ANTHROPIC_MODELS=your-anthropic-model-id
```

Build and start normally. When at least one Anthropic model is configured, server startup automatically reads the `com.turnturn.anthropic-api-key` item for the current macOS account. The browser receives model labels and profile ids only; it never receives the credential.

To replace the stored key, run the setup script again. To use another secret manager, set `ANTHROPIC_API_KEY_HELPER` to an absolute executable path that prints exactly one credential line.

## Provider connection, wire adapter, and model

These are three separate facts (design.md D30):

- **Provider connection** — which configured account or local runtime receives the request (`TURNTURN_PROVIDER` + `TURNTURN_BASE_URL` + its credential).
- **Wire adapter** — which HTTP request/stream grammar is spoken. This is always the connection's configured kind, literally — it is never inferred from a model's name. A LiteLLM connection routing a model named `bedrock-claude-5-sonnet` still speaks `openai-chat-completions`, not `anthropic-messages`.
- **Model** — just the provider-visible model id string that connection is asked for.

On top of the profiles configured through environment variables, the server discovers additional models per connection at startup and whenever the model picker's Refresh is used:

- a direct Anthropic connection (`TURNTURN_PROVIDER=anthropic-messages`, or any `TURNTURN_ANTHROPIC_MODELS` configured) lists every model the resolved credential can see via `GET /v1/models`;
- an OpenAI-compatible connection (`TURNTURN_PROVIDER=openai-chat-completions`, e.g. a LiteLLM gateway) lists every model `TURNTURN_API_KEY` can see via the gateway's `GET /v1/models` — these are LiteLLM routing names, not proof of the upstream model's real wire format;
- a local Ollama connection (`TURNTURN_PROVIDER=ollama`) lists installed models via `GET /api/tags` and checks tool-call capability per model via `POST /api/show`.

Discovery never blocks startup, never requires a credential beyond what is already configured, and never removes a configured profile. One connection being unreachable only shows as `unavailable` for that connection in the model picker (`GET /api/providers`); the rest of the catalog, and the server, keep working. The browser only ever receives the safe grouped catalog — no credential, header, or private endpoint URL crosses that boundary.

If a conversation's previously selected model later disappears from discovery (the provider stopped listing it, or the connection is temporarily down), that conversation stays fully readable. The model picker marks the selection unavailable, and starting a new turn against it is rejected with a structured error before any request is made to the provider.

### Manual acceptance (5.4c.8)

To exercise all three connection kinds by hand, point `TURNTURN_PROVIDER`/`TURNTURN_BASE_URL`/`TURNTURN_API_KEY` at each in turn (direct Anthropic, a LiteLLM-style gateway, and a local Ollama), restart the server, and in the browser: open the model picker, confirm the connection appears grouped with the right label and status, confirm `Refresh` updates it, and confirm switching models creates a new session boundary. A connection with no credential configured, or an Ollama that is not running, is an expected `unavailable`/`idle` state to record — not a reason to fabricate a passing run.
