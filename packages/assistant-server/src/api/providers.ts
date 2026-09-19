import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "../json.js";
import type { AssistantRuntime } from "../runtime.js";

/**
 * `GET /api/providers` and `POST /api/providers/refresh`. Both already sit behind the
 * server's token check in `http-server.ts` (D23) — there is nothing further to gate
 * here. Neither route ever serializes a credential, header, helper path, or full
 * endpoint URL; `ModelCatalog.providerSnapshot()` is the only place that shape is
 * produced, and it is built from public facts only.
 */
export async function handleProvidersApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: AssistantRuntime,
): Promise<boolean> {
  if (url.pathname !== "/api/providers" && url.pathname !== "/api/providers/refresh") return false;
  const method = req.method ?? "GET";
  if (url.pathname === "/api/providers" && method === "GET") {
    writeJson(res, 200, runtime.models.providerSnapshot());
    return true;
  }
  if (url.pathname === "/api/providers/refresh" && method === "POST") {
    await runtime.models.refreshAll();
    writeJson(res, 200, runtime.models.providerSnapshot());
    return true;
  }
  writeJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${url.pathname}` } });
  return true;
}
