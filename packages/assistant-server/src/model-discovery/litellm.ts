import { boundedFetch, DiscoveryAbortedError, DiscoveryTimeoutError } from "./http.js";
import type { DiscoveredModelOption, DiscoveryOutcome } from "./types.js";

/**
 * Pure parser for an OpenAI-compatible `GET /v1/models` response, as served by a
 * LiteLLM gateway. These entries are LiteLLM routing names, not native upstream wire
 * truth (D30) — tool compatibility is therefore always reported `unknown`, never
 * inferred from the model id text.
 */
export function parseLiteLlmModelsResponse(body: unknown): readonly DiscoveredModelOption[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("UNEXPECTED_SHAPE");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.data)) throw new Error("UNEXPECTED_SHAPE");
  const byId = new Map<string, DiscoveredModelOption>();
  for (const entry of record.data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("UNEXPECTED_SHAPE");
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) throw new Error("UNEXPECTED_SHAPE");
    byId.set(id, { modelId: id, label: id, toolCompatibility: "unknown" });
  }
  return [...byId.values()];
}

export interface LiteLlmDiscoveryOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function discoverLiteLlmModels(options: LiteLlmDiscoveryOptions): Promise<DiscoveryOutcome> {
  try {
    const url = new URL("/v1/models", options.baseUrl);
    const response = await boundedFetch({
      url: url.toString(),
      headers: options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    if (response.status === 401) return { status: "error", code: "UNAUTHORIZED" };
    if (response.status === 403) return { status: "error", code: "FORBIDDEN" };
    if (response.status >= 500) return { status: "error", code: "SERVER_ERROR" };
    if (response.status !== 200) return { status: "error", code: "SERVER_ERROR" };
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(response.text);
    } catch {
      return { status: "error", code: "MALFORMED_RESPONSE" };
    }
    try {
      return { status: "ok", models: parseLiteLlmModelsResponse(parsedBody) };
    } catch {
      return { status: "error", code: "UNEXPECTED_SHAPE" };
    }
  } catch (cause) {
    if (cause instanceof DiscoveryAbortedError) return { status: "error", code: "ABORTED" };
    if (cause instanceof DiscoveryTimeoutError) return { status: "error", code: "TIMEOUT" };
    return { status: "error", code: "NETWORK_ERROR" };
  }
}
