import type { ProviderEvent, ProviderRequest } from "../../ports.js";
import type { OpenAIChatCompletionsAdapterOptions } from "./adapter.js";
import { buildChatCompletionsRequest } from "./request.js";

export type ChatCompletionsHttpResult =
  | { readonly kind: "stream"; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: "failed"; readonly event: Extract<ProviderEvent, { readonly type: "failed" }> };

export type ChatCompletionsHttpClient = (
  options: OpenAIChatCompletionsAdapterOptions,
  request: ProviderRequest,
) => Promise<ChatCompletionsHttpResult>;

export const requestChatCompletionsStream: ChatCompletionsHttpClient = async (options, request) => {
  try {
    const { url, init } = buildChatCompletionsRequest(options, request);
    const response = await fetch(url, init);
    if (!response.ok) {
      return { kind: "failed", event: { type: "failed", error: await classifyHttpFailure(response) } };
    }

    if (!response.body) {
      return {
        kind: "failed",
        event: {
          type: "failed",
          error: { kind: "transport", message: "OpenAI chat-completions response had no body", retryable: true },
        },
      };
    }

    return { kind: "stream", body: response.body };
  } catch (error) {
    return {
      kind: "failed",
      event: {
        type: "failed",
        error: {
          kind: "transport",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      },
    };
  }
};

export async function classifyHttpFailure(response: Response) {
  return {
    kind: response.status === 400 ? "request-rejected" : "transport",
    message: await response.text(),
    retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status),
    status: response.status,
  } as const;
}
