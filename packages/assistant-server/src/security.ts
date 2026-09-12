import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./json.js";

export function authorizeRequest(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  const host = req.headers.host;
  const address = req.socket.address();
  const port = typeof address === "object" && address !== null && "port" in address ? address.port : undefined;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (host === undefined || !allowedHosts.has(host)) return refuse(res, 403, "INVALID_HOST");

  const origin = req.headers.origin;
  if (origin !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) {
    let allowed = false;
    try {
      const parsed = new URL(origin);
      allowed = parsed.protocol === "http:" && parsed.host === host;
    } catch {
      allowed = false;
    }
    if (!allowed) return refuse(res, 403, "INVALID_ORIGIN");
  }

  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/commands" || pathname.startsWith("/api/")) {
    const supplied = req.headers["x-turnturn-token"];
    if (typeof supplied !== "string" || !equalToken(supplied, token)) return refuse(res, 401, "INVALID_TOKEN");
  }
  if (pathname === "/events") {
    const supplied = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
    if (supplied === null || !equalToken(supplied, token)) return refuse(res, 401, "INVALID_TOKEN");
  }
  return true;
}

function equalToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function refuse(res: ServerResponse, status: number, code: string): false {
  writeJson(res, status, { error: { code, message: "Request refused" } });
  return false;
}
