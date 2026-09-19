import type { JsonValue } from "@turnturn/protocol";
import type { ProviderRequest } from "../../ports.js";
import type { AnthropicMessagesAdapterOptions } from "./adapter.js";
import { providerHistoryToAnthropicMessages } from "./history.js";

export interface AnthropicMessagesWireRequest {
  readonly method: "POST";
  readonly route: string;
  readonly body: JsonValue;
}

export interface AnthropicMessagesRequest {
  readonly url: URL;
  readonly init: RequestInit;
  readonly wire: AnthropicMessagesWireRequest;
}

export function buildAnthropicMessagesRequest(
  options: AnthropicMessagesAdapterOptions,
  request: ProviderRequest,
): AnthropicMessagesRequest {
  const url = new URL("/v1/messages", normalizedBaseUrl(options.baseUrl ?? "https://api.anthropic.com"));
  const body = buildAnthropicMessagesRequestBody(options, request);
  return {
    url,
    wire: { method: "POST", route: url.pathname, body },
    init: {
      method: "POST",
      signal: request.signal,
      headers: buildAnthropicMessagesHeaders(options),
      body: JSON.stringify(body),
    },
  };
}

export function buildAnthropicMessagesHeaders(
  options: Pick<AnthropicMessagesAdapterOptions, "apiKey" | "anthropicVersion" | "headers">,
): Record<string, string> {
  return {
    "x-api-key": options.apiKey,
    "anthropic-version": options.anthropicVersion ?? "2023-06-01",
    "content-type": "application/json",
    accept: "text/event-stream",
    ...options.headers,
  };
}

export function buildAnthropicMessagesRequestBody(
  options: Pick<AnthropicMessagesAdapterOptions, "maxTokens" | "model">,
  request: ProviderRequest,
): JsonValue {
  return {
    model: options.model,
    stream: true,
    max_tokens: options.maxTokens ?? 4096,
    messages: providerHistoryToAnthropicMessages(request.history.items),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }),
  };
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
