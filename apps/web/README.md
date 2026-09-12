# Turnturn Web Harness

Reusable React client for driving the local assistant server.

Run the server:

```bash
TURNTURN_PROVIDER=ollama TURNTURN_MODEL=llama3.2 \
pnpm --filter @turnturn/assistant-server exec turnturn-assistant-server
```

Copy the token printed by the server into `VITE_TURNTURN_TOKEN`, then run the web client:

```bash
VITE_TURNTURN_TOKEN=<token-from-server-banner> pnpm --filter @turnturn/web dev
```
