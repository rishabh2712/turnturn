#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { env, exit, stdout } from "node:process";
import { loadEnvFile } from "./env-file.js";
import { createAssistantHttpServer } from "./http-server.js";
import { createAssistantRuntime, type ProviderKind } from "./runtime.js";

loadEnvFile();

const provider = (env.TURNTURN_PROVIDER ?? "ollama") as ProviderKind;
const model = env.TURNTURN_MODEL;
const workspace = resolve(env.TURNTURN_WORKSPACE ?? process.cwd());
const port = Number(env.TURNTURN_PORT ?? "8787");
const baseUrl = env.TURNTURN_BASE_URL;
const apiKey = env.TURNTURN_API_KEY;
const maxTokens = env.TURNTURN_MAX_TOKENS === undefined ? undefined : Number(env.TURNTURN_MAX_TOKENS);
const staticDir = env.TURNTURN_WEB_DIST === undefined ? undefined : resolve(env.TURNTURN_WEB_DIST);
const token = randomBytes(32).toString("hex");

if (!model || !["ollama", "openai-chat-completions"].includes(provider)) {
  stdout.write(
    "usage: TURNTURN_MODEL=<model> [TURNTURN_PROVIDER=ollama|openai-chat-completions] turnturn-assistant-server\n",
  );
  exit(2);
}

const runtime = createAssistantRuntime({
  workspace,
  provider,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(apiKey === undefined ? {} : { apiKey }),
  model,
  ...(maxTokens === undefined ? {} : { maxTokens }),
});
const server = createAssistantHttpServer({ runtime, token, ...(staticDir === undefined ? {} : { staticDir }) });

server.listen(port, "127.0.0.1", () => {
  stdout.write(`turnturn assistant server http://127.0.0.1:${port}\n`);
  stdout.write(`workspace ${workspace}\n`);
  stdout.write(`provider  ${provider}\n`);
  stdout.write(`model     ${model}\n`);
  stdout.write(`token     ${token}\n`);
});
