import type { ProviderEvent, ProviderFailure, ProviderRequest } from "../../ports.js";
import type { AnthropicMessagesAdapterOptions } from "./adapter.js";
import { type AnthropicMessagesWireRequest, buildAnthropicMessagesRequest } from "./request.js";

export type AnthropicMessagesHttpResult =
  | {
      readonly kind: "stream";
      readonly body: ReadableStream<Uint8Array>;
      readonly status: number;
      readonly upstreamRequestId?: string;
    }
  | {
      readonly kind: "failed";
      readonly event: Extract<ProviderEvent, { readonly type: "failed" }>;
      readonly status?: number;
      readonly upstreamRequestId?: string;
    };

export type AnthropicMessagesHttpClient = (
  options: AnthropicMessagesAdapterOptions,
  request: ProviderRequest,
  hooks: { readonly beforeFetch: (request: AnthropicMessagesWireRequest) => void },
) => Promise<AnthropicMessagesHttpResult>;

export const requestAnthropicMessagesStream: AnthropicMessagesHttpClient = async (options, request, hooks) => {
  try {
    const { url, init, wire } = buildAnthropicMessagesRequest(options, request);
    hooks.beforeFetch(wire);
    const response = await fetch(url, init);
    const upstreamRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) {
      return {
        kind: "failed",
        event: { type: "failed", error: await classifyAnthropicHttpFailure(response) },
        status: response.status,
        ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
      };
    }
    if (response.body === null) {
      return {
        kind: "failed",
        event: {
          type: "failed",
          error: { kind: "transport", message: "Anthropic Messages response had no body", retryable: true },
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
          retryable: !request.signal.aborted,
        },
      },
    };
  }
};

export async function classifyAnthropicHttpFailure(response: Response): Promise<ProviderFailure> {
  const message = await response.text();
  const status = response.status;
  return {
    kind:
      status === 413
        ? "context-limit"
        : status >= 400 && status < 500 && status !== 408 && status !== 429
          ? "request-rejected"
          : "transport",
    message,
    retryable: [408, 429, 500, 502, 503, 504, 529].includes(status),
    status,
  };
}
