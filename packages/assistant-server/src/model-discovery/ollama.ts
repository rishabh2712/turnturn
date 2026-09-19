import { boundedFetch, DiscoveryAbortedError, DiscoveryTimeoutError } from "./http.js";
import type { DiscoveredModelOption, DiscoveryOutcome, ToolCompatibility } from "./types.js";

export function parseOllamaTagsResponse(body: unknown): readonly string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("UNEXPECTED_SHAPE");
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.models)) throw new Error("UNEXPECTED_SHAPE");
  const names = new Set<string>();
  for (const entry of record.models) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("UNEXPECTED_SHAPE");
    const name = (entry as Record<string, unknown>).model ?? (entry as Record<string, unknown>).name;
    if (typeof name !== "string" || name.length === 0) throw new Error("UNEXPECTED_SHAPE");
    names.add(name);
  }
  return [...names];
}

/**
 * Pure parser for `POST /api/show`. A model without `completion` in its declared
 * capabilities is not selectable at all (D30); one that declares capabilities but not
 * `tools` is an explicit `unknown` warning rather than silent support.
 */
export function parseOllamaShowResponse(body: unknown): {
  readonly selectable: boolean;
  readonly toolCompatibility: ToolCompatibility;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("UNEXPECTED_SHAPE");
  const capabilities = (body as Record<string, unknown>).capabilities;
  if (capabilities === undefined) return { selectable: true, toolCompatibility: "unknown" };
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
    throw new Error("UNEXPECTED_SHAPE");
  }
  const list = capabilities as string[];
  if (!list.includes("completion")) return { selectable: false, toolCompatibility: "unsupported" };
  return { selectable: true, toolCompatibility: list.includes("tools") ? "supported" : "unknown" };
}

export interface OllamaDiscoveryOptions {
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Bounds the number of `POST /api/show` capability checks per refresh. */
  readonly maxCapabilityChecks?: number;
}

export async function discoverOllamaModels(options: OllamaDiscoveryOptions = {}): Promise<DiscoveryOutcome> {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
  const fetchOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  let names: readonly string[];
  try {
    const response = await boundedFetch({ url: new URL("/api/tags", baseUrl).toString(), ...fetchOptions });
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
      names = parseOllamaTagsResponse(parsedBody);
    } catch {
      return { status: "error", code: "UNEXPECTED_SHAPE" };
    }
  } catch (cause) {
    if (cause instanceof DiscoveryAbortedError) return { status: "error", code: "ABORTED" };
    if (cause instanceof DiscoveryTimeoutError) return { status: "error", code: "TIMEOUT" };
    return { status: "error", code: "NETWORK_ERROR" };
  }

  const maxChecks = options.maxCapabilityChecks ?? 25;
  const models: DiscoveredModelOption[] = [];
  for (const name of names.slice(0, maxChecks)) {
    let capability: { readonly selectable: boolean; readonly toolCompatibility: ToolCompatibility } = {
      selectable: true,
      toolCompatibility: "unknown",
    };
    try {
      const showResponse = await boundedFetch({
        url: new URL("/api/show", baseUrl).toString(),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name }),
        ...fetchOptions,
      });
      if (showResponse.status === 200) {
        capability = parseOllamaShowResponse(JSON.parse(showResponse.text));
      }
      // A non-200 or malformed /api/show for a single model degrades that model to an
      // "unknown" warning rather than failing the whole discovery pass.
    } catch {
      // same degrade-one-model behavior on network/timeout for a single capability check.
    }
    if (capability.selectable) {
      models.push({ modelId: name, label: name, toolCompatibility: capability.toolCompatibility });
    } else {
      models.push({ modelId: name, label: name, toolCompatibility: "unsupported" });
    }
  }
  for (const name of names.slice(maxChecks)) {
    models.push({ modelId: name, label: name, toolCompatibility: "unknown" });
  }
  return { status: "ok", models };
}
