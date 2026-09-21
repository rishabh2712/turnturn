#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { env, exit, stdout } from "node:process";
import { resolveAnthropicApiKey } from "./credentials.js";
import { loadEnvFile } from "./env-file.js";
import { createAssistantHttpServer } from "./http-server.js";
import { discoverAnthropicModels } from "./model-discovery/anthropic.js";
import { discoverLiteLlmModels } from "./model-discovery/litellm.js";
import { discoverOllamaModels } from "./model-discovery/ollama.js";
import { createPersistentRuntime } from "./persistent-runtime.js";
import {
  createAssistantRuntime,
  type DiscoveryConnectionConfig,
  type ModelProfileConfig,
  type ProviderKind,
} from "./runtime.js";

loadEnvFile();

const provider = (env.TURNTURN_PROVIDER ?? "ollama") as ProviderKind;
const model = env.TURNTURN_MODEL;
const workspace = resolve(env.TURNTURN_WORKSPACE ?? process.cwd());
const port = Number(env.TURNTURN_PORT ?? "8787");
const baseUrl = env.TURNTURN_BASE_URL;
const anthropicModels = parseModelList(env.TURNTURN_ANTHROPIC_MODELS);
const needsAnthropicCredential = provider === "anthropic-messages" || anthropicModels.length > 0;
const anthropicApiKey = needsAnthropicCredential ? await resolveAnthropicApiKey() : undefined;
const apiKey = provider === "anthropic-messages" ? anthropicApiKey : env.TURNTURN_API_KEY;
const maxTokens = env.TURNTURN_MAX_TOKENS === undefined ? undefined : Number(env.TURNTURN_MAX_TOKENS);
const staticDir = env.TURNTURN_WEB_DIST === undefined ? undefined : resolve(env.TURNTURN_WEB_DIST);
const trace = env.TURNTURN_TRACE !== "0" && env.TURNTURN_TRACE !== "false";
const traceRawResponseMaxBytes =
  env.TURNTURN_TRACE_RAW_RESPONSE_MAX_BYTES === undefined
    ? undefined
    : Number(env.TURNTURN_TRACE_RAW_RESPONSE_MAX_BYTES);
const token = randomBytes(32).toString("hex");

if (!model || !["anthropic-messages", "ollama", "openai-chat-completions"].includes(provider)) {
  stdout.write(
    "usage: TURNTURN_MODEL=<model> [TURNTURN_PROVIDER=anthropic-messages|ollama|openai-chat-completions] turnturn-assistant-server\n",
  );
  exit(2);
}

const modelProfiles = configuredModelProfiles({
  provider,
  model,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(maxTokens === undefined ? {} : { maxTokens }),
  anthropicModels,
  ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
});

const discoveryConnections = configuredDiscoveryConnections({
  provider,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(maxTokens === undefined ? {} : { maxTokens }),
  ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
});

const runtime = createAssistantRuntime({
  workspace,
  provider,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(apiKey === undefined ? {} : { apiKey }),
  model,
  ...(maxTokens === undefined ? {} : { maxTokens }),
  modelProfiles,
  defaultModelProfileId: "default",
  discoveryConnections,
  trace,
  ...(traceRawResponseMaxBytes === undefined ? {} : { traceRawResponseMaxBytes }),
});
const persistent = await createPersistentRuntime(runtime, { port });
const server = createAssistantHttpServer({
  runtime,
  persistent,
  token,
  ...(staticDir === undefined ? {} : { staticDir }),
});

server.listen(port, "127.0.0.1", () => {
  stdout.write(`turnturn assistant server http://127.0.0.1:${port}\n`);
  stdout.write(`workspace ${workspace}\n`);
  stdout.write(`provider  ${provider}\n`);
  stdout.write(`model     ${model}\n`);
  stdout.write(`models    ${modelProfiles.map((profile) => profile.id).join(", ")}\n`);
  stdout.write(`token     ${token}\n`);
});

function configuredModelProfiles(options: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly anthropicModels: readonly string[];
  readonly anthropicApiKey?: string;
}): readonly ModelProfileConfig[] {
  const profiles: ModelProfileConfig[] = [
    {
      id: "default",
      connectionId: options.provider,
      label: options.model,
      provider: options.provider,
      model: options.model,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    },
  ];
  if (options.anthropicModels.length > 0 && options.anthropicApiKey === undefined) {
    throw new Error("TURNTURN_ANTHROPIC_MODELS requires an Anthropic credential");
  }
  for (const [index, anthropicModel] of options.anthropicModels.entries()) {
    if (options.provider === "anthropic-messages" && anthropicModel === options.model) continue;
    profiles.push({
      id: `anthropic-${index + 1}`,
      connectionId: "anthropic-messages",
      label: anthropicModel,
      provider: "anthropic-messages",
      model: anthropicModel,
      apiKey: options.anthropicApiKey as string,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
  }
  return profiles;
}

function configuredDiscoveryConnections(options: {
  readonly provider: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly anthropicApiKey?: string;
}): readonly DiscoveryConnectionConfig[] {
  const connections: DiscoveryConnectionConfig[] = [];
  const anthropicKey = options.provider === "anthropic-messages" ? options.apiKey : options.anthropicApiKey;
  if (anthropicKey !== undefined) {
    connections.push({
      id: "anthropic-messages",
      wire: "anthropic-messages",
      label: "Anthropic",
      locality: "remote",
      apiKey: anthropicKey,
      ...(options.provider === "anthropic-messages" && options.baseUrl !== undefined
        ? { baseUrl: options.baseUrl }
        : {}),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      discover: (signal) =>
        discoverAnthropicModels({
          apiKey: anthropicKey,
          signal,
          ...(options.baseUrl === undefined || options.provider !== "anthropic-messages"
            ? {}
            : { baseUrl: options.baseUrl }),
        }),
    });
  }
  if (options.provider === "ollama") {
    connections.push({
      id: "ollama",
      wire: "ollama",
      label: "Ollama (local)",
      locality: "local",
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      discover: (signal) =>
        discoverOllamaModels({ signal, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) }),
    });
  }
  if (options.provider === "openai-chat-completions") {
    const baseUrl = options.baseUrl ?? "https://api.openai.com";
    connections.push({
      id: "openai-chat-completions",
      wire: "openai-chat-completions",
      label: "OpenAI-compatible",
      locality: "remote",
      baseUrl,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      discover: (signal) =>
        discoverLiteLlmModels({ baseUrl, signal, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) }),
    });
  }
  return connections;
}

function parseModelList(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}
