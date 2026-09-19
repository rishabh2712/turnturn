import { boundedFetch, DiscoveryAbortedError, DiscoveryTimeoutError } from "./http.js";
import type { DiscoveredModelOption, DiscoveryOutcome } from "./types.js";

export interface AnthropicModelsPage {
  readonly models: readonly DiscoveredModelOption[];
  readonly hasMore: boolean;
  readonly lastId?: string;
}

/** Pure parser for one `GET /v1/models` page. Throws on any shape it does not recognize. */
export function parseAnthropicModelsPage(body: unknown): AnthropicModelsPage {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("UNEXPECTED_SHAPE");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.data)) throw new Error("UNEXPECTED_SHAPE");
  const models: DiscoveredModelOption[] = [];
  for (const entry of record.data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("UNEXPECTED_SHAPE");
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) throw new Error("UNEXPECTED_SHAPE");
    const displayName = (entry as Record<string, unknown>).display_name;
    models.push({
      modelId: id,
      label: typeof displayName === "string" && displayName.length > 0 ? displayName : id,
      // The native Anthropic Messages API supports tool use for every model it lists.
      toolCompatibility: "supported",
    });
  }
  const lastId = record.last_id;
  return {
    models,
    hasMore: record.has_more === true,
    ...(typeof lastId === "string" ? { lastId } : {}),
  };
}

export interface AnthropicDiscoveryOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

export async function discoverAnthropicModels(options: AnthropicDiscoveryOptions): Promise<DiscoveryOutcome> {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const maxPages = options.maxPages ?? 10;
  const collected = new Map<string, DiscoveredModelOption>();
  let afterId: string | undefined;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL("/v1/models", baseUrl);
      url.searchParams.set("limit", "100");
      if (afterId !== undefined) url.searchParams.set("after_id", afterId);
      const response = await boundedFetch({
        url: url.toString(),
        headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
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
      let parsedPage: AnthropicModelsPage;
      try {
        parsedPage = parseAnthropicModelsPage(parsedBody);
      } catch {
        return { status: "error", code: "UNEXPECTED_SHAPE" };
      }
      for (const model of parsedPage.models) collected.set(model.modelId, model);
      if (!parsedPage.hasMore || parsedPage.lastId === undefined) break;
      afterId = parsedPage.lastId;
    }
    return { status: "ok", models: [...collected.values()] };
  } catch (cause) {
    if (cause instanceof DiscoveryAbortedError) return { status: "error", code: "ABORTED" };
    if (cause instanceof DiscoveryTimeoutError) return { status: "error", code: "TIMEOUT" };
    return { status: "error", code: "NETWORK_ERROR" };
  }
}
