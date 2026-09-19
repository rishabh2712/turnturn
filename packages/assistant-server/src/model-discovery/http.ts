export class DiscoveryTimeoutError extends Error {
  constructor() {
    super("Discovery request timed out");
    this.name = "DiscoveryTimeoutError";
  }
}

export class DiscoveryAbortedError extends Error {
  constructor() {
    super("Discovery request was aborted");
    this.name = "DiscoveryAbortedError";
  }
}

export interface BoundedFetchOptions {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface BoundedFetchResult {
  readonly status: number;
  readonly text: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * A `fetch` wrapper bounded by both an internal timeout and an optional external
 * abort signal, reporting which one fired. Every provider discovery client goes
 * through this instead of calling `fetch` directly, so timeout/abort/network-error
 * classification is identical across providers.
 */
export async function boundedFetch(options: BoundedFetchOptions): Promise<BoundedFetchResult> {
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.url, {
      method: options.method ?? "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (cause) {
    if (options.signal?.aborted === true) throw new DiscoveryAbortedError();
    if (timedOut) throw new DiscoveryTimeoutError();
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
