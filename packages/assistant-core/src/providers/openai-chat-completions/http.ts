import type { ProviderEvent, ProviderRequest } from "../../ports.js";
import type { OpenAIChatCompletionsAdapterOptions } from "./adapter.js";
import { buildChatCompletionsRequest, type ChatCompletionsWireRequest } from "./request.js";

export type ChatCompletionsHttpResult =
  | {
      readonly kind: "stream";
      readonly body: ReadableStream<Uint8Array>;
      readonly status?: number;
      readonly upstreamRequestId?: string;
    }
  | {
      readonly kind: "failed";
      readonly event: Extract<ProviderEvent, { readonly type: "failed" }>;
      readonly status?: number;
      readonly upstreamRequestId?: string;
    };

export type ChatCompletionsHttpClient = (
  options: OpenAIChatCompletionsAdapterOptions,
  request: ProviderRequest,
  hooks: ChatCompletionsTransportHooks,
) => Promise<ChatCompletionsHttpResult>;

export interface ChatCompletionsTransportHooks {
  readonly beforeFetch: (request: ChatCompletionsWireRequest) => void;
}

export const requestChatCompletionsStream: ChatCompletionsHttpClient = async (options, request, hooks) => {
  try {
    const { url, init, wire } = buildChatCompletionsRequest(options, request);
    hooks.beforeFetch(wire);
    const response = await fetch(url, init);
    const upstreamRequestId = response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) {
      return {
        kind: "failed",
        event: { type: "failed", error: await classifyHttpFailure(response) },
        status: response.status,
        ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
      };
    }

    if (!response.body) {
      return {
        kind: "failed",
        event: {
          type: "failed",
          error: { kind: "transport", message: "OpenAI chat-completions response had no body", retryable: true },
        },
        status: response.status,
        ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
      };
    }

    return {
      kind: "stream",
      body: response.body,
      status: response.status,
      ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
    };
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
