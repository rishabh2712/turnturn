import type { JsonValue } from "@turnturn/protocol";
import type { ProviderRequest } from "../../ports.js";
import type { OpenAIChatCompletionsAdapterOptions } from "./adapter.js";
import { providerHistoryToChatMessages } from "./history.js";

export interface ChatCompletionsRequest {
  readonly url: URL;
  readonly init: RequestInit;
}

export function buildChatCompletionsRequest(
  options: OpenAIChatCompletionsAdapterOptions,
  request: ProviderRequest,
): ChatCompletionsRequest {
  return {
    url: new URL("/v1/chat/completions", normalizedBaseUrl(options.baseUrl)),
    init: {
      method: "POST",
      signal: request.signal,
      headers: buildChatCompletionsHeaders(options),
      body: JSON.stringify(buildChatCompletionsRequestBody(options, request)),
    },
  };
}

export function buildChatCompletionsHeaders(
  options: Pick<OpenAIChatCompletionsAdapterOptions, "apiKey" | "headers">,
): Record<string, string> {
  return {
    ...(options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` }),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...options.headers,
  };
}

export function buildChatCompletionsRequestBody(
  options: Pick<OpenAIChatCompletionsAdapterOptions, "maxTokens" | "model">,
  request: ProviderRequest,
): JsonValue {
  const tools = request.tools ?? [];
  return {
    model: options.model,
    stream: true,
    messages: providerHistoryToChatMessages(request.history.items),
    ...(tools.length === 0 ? {} : { tools: tools.map(openAiToolDefinition), tool_choice: "auto" }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  };
}

function openAiToolDefinition(tool: ProviderRequest["tools"][number]): JsonValue {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
