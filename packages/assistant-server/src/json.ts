import { serializeJson } from "@turnturn/protocol";

export type JsonResponse = {
  readonly status: number;
  readonly body: unknown;
};

export function jsonResponse(status: number, body: unknown): JsonResponse {
  return { status, body };
}

export function parseJsonBody(text: string): unknown {
  return JSON.parse(text);
}

export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(serializeJson(value)) as T;
}

export function writeJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const serialized = serializeJson(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(serialized);
}
