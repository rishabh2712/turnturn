import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { CommandEnvelope, DurableRecord } from "@turnturn/protocol";
import { jsonRoundTrip, parseJsonBody, writeJson } from "./json.js";
import type { AssistantRuntime } from "./runtime.js";
import { runtimeDebugState } from "./runtime.js";
import { authorizeRequest } from "./security.js";

export interface CreateAssistantHttpServerOptions {
  readonly runtime: AssistantRuntime;
  readonly staticDir?: string;
  readonly token: string;
}

export function createAssistantHttpServer(options: CreateAssistantHttpServerOptions): Server {
  return createServer((req, res) => {
    handleRequest(req, res, options).catch((error: unknown) => {
      writeJson(res, 500, {
        error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateAssistantHttpServerOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!authorizeRequest(req, res, options.token)) return;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (method === "POST" && url.pathname === "/commands") {
    await postCommand(req, res, options.runtime);
    return;
  }

  if (method === "GET" && url.pathname === "/events") {
    openEvents(res);
    const cleanup = options.runtime.live.subscribe(res);
    req.on("close", cleanup);
    return;
  }

  if (method === "GET" && url.pathname === "/records") {
    const afterSequence = parseSequence(url.searchParams.get("afterSequence") ?? "0");
    writeJson(res, 200, { records: recordsAfter(options.runtime.records(), afterSequence) });
    return;
  }

  if (method === "GET" && url.pathname === "/debug/state") {
    writeJson(res, 200, runtimeDebugState(options.runtime));
    return;
  }

  if (method === "GET" && options.staticDir !== undefined) {
    const served = await serveStatic(url.pathname, res, options.staticDir, options.token);
    if (served) return;
  }

  writeJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${url.pathname}` } });
}

async function postCommand(req: IncomingMessage, res: ServerResponse, runtime: AssistantRuntime): Promise<void> {
  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (error) {
    writeJson(res, 400, {
      error: { code: "INVALID_JSON", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }

  let command: CommandEnvelope;
  try {
    command = jsonRoundTrip(parsed) as CommandEnvelope;
  } catch (error) {
    writeJson(res, 400, {
      error: { code: "NON_SERIALIZABLE_COMMAND", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }

  const outcome = await runtime.engine.submit(command);
  writeJson(res, 200, jsonRoundTrip(outcome));
}

function openEvents(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

function recordsAfter(records: readonly DurableRecord[], afterSequence: number): readonly DurableRecord[] {
  return records.filter((record) => record.sequence > afterSequence);
}

function parseSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isInteger(sequence) || sequence < 0) return 0;
  return sequence;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(pathname: string, res: ServerResponse, staticDir: string, token: string): Promise<boolean> {
  const root = resolve(staticDir);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(root, `.${normalize(decodeURIComponent(requested))}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return false;

  try {
    const bytes = await readFile(target);
    res.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store",
    });
    res.end(extname(target) === ".html" ? injectToken(bytes.toString("utf8"), token) : bytes);
    return true;
  } catch {
    if (extname(target) === "") {
      try {
        const bytes = await readFile(join(root, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(injectToken(bytes.toString("utf8"), token));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function injectToken(html: string, token: string): string {
  return html.replace("</head>", `<script>window.__TURNTURN__={token:${JSON.stringify(token)}}</script></head>`);
}

function contentType(file: string): string {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
