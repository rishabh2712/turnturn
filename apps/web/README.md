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
