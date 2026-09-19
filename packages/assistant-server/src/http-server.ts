import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type CommandEnvelope, CommandTypes, type ConversationId, parseId } from "@turnturn/protocol";
import { handleConversationApi } from "./api/conversations.js";
import { handleProvidersApi } from "./api/providers.js";
import { handleReadOnlyApi } from "./api/read-only.js";
import { handleTraceApi } from "./api/traces.js";
import { jsonRoundTrip, parseJsonBody, writeJson } from "./json.js";
import type { ConversationSnapshot } from "./live-broadcaster.js";
import type { PersistentRuntime } from "./persistent-runtime.js";
import type { AssistantRuntime } from "./runtime.js";
import { runtimeDebugState } from "./runtime.js";
import { authorizeRequest } from "./security.js";

export interface CreateAssistantHttpServerOptions {
  readonly runtime: AssistantRuntime;
  readonly staticDir?: string;
  readonly token: string;
  readonly persistent?: PersistentRuntime;
}

export function createAssistantHttpServer(options: CreateAssistantHttpServerOptions): Server {
  const inFlight = new Map<string, { turnId: string; promise: Promise<unknown> }>();
  const server = createServer((req, res) => {
    handleRequest(req, res, options, inFlight).catch((error: unknown) => {
      writeJson(res, 500, {
        error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
  if (options.persistent !== undefined) {
    server.on("close", () => {
      void Promise.allSettled([...inFlight.values()].map((entry) => entry.promise)).then(() =>
        options.persistent?.close(),
      );
    });
  }
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateAssistantHttpServerOptions,
  inFlight: Map<string, { turnId: string; promise: Promise<unknown> }>,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!authorizeRequest(req, res, options.token)) return;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (options.persistent !== undefined && (await handleConversationApi(req, res, url, options.persistent))) return;
  if (options.persistent !== undefined && (await handleTraceApi(req, res, url, options.persistent))) return;
  if (options.persistent !== undefined && (await handleReadOnlyApi(req, res, url, options.runtime, options.persistent)))
    return;
  if (await handleProvidersApi(req, res, url, options.runtime)) return;

  if (method === "POST" && url.pathname === "/commands") {
    await postCommand(req, res, options.runtime, options.persistent, inFlight);
    return;
  }

  if (method === "GET" && url.pathname === "/events") {
    const persistent = options.persistent;
    if (persistent !== undefined) {
      let conversationId: ConversationId;
      try {
        conversationId = parseId("conv", url.searchParams.get("conversationId") ?? "");
      } catch {
        writeJson(res, 400, { error: { code: "CONVERSATION_REQUIRED" } });
        return;
      }
      const conversation = await persistent.store.get(conversationId);
      if (conversation === undefined) {
        writeJson(res, 404, { error: { code: "CONVERSATION_NOT_FOUND" } });
        return;
      }
      const sessions = await Promise.all(
        conversation.sessions.map(async (session) => ({
          sessionId: session.sessionId,
          runtime: await persistent.sessions.open(conversationId, session.sessionId),
        })),
      );
      openEvents(res);
      const cleanup = options.runtime.live.subscribeConversation(
        res,
        conversationId,
        (): ConversationSnapshot => ({
          conversationId,
          serverInstanceId: persistent.serverInstanceId,
          sessions: sessions.map(({ sessionId, runtime }) => ({
            sessionId,
            lastSequence: runtime.durable.records().at(-1)?.sequence ?? 0,
          })),
        }),
      );
      req.on("close", cleanup);
      return;
    }
    openEvents(res);
    const cleanup = options.runtime.live.subscribe(res);
    req.on("close", cleanup);
    return;
  }

  if (method === "GET" && url.pathname === "/debug/state") {
    writeJson(res, 200, runtimeDebugState(options.runtime));
    return;
  }

  if (
    method === "GET" &&
    options.staticDir !== undefined &&
    !["/api", "/records"].some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))
  ) {
    const served = await serveStatic(url.pathname, res, options.staticDir, options.token);
    if (served) return;
  }

  writeJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${url.pathname}` } });
}

async function postCommand(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AssistantRuntime,
  persistent: PersistentRuntime | undefined,
  inFlight: Map<string, { turnId: string; promise: Promise<unknown> }>,
): Promise<void> {
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

  if (persistent !== undefined) {
    if (command.conversationId === undefined || command.sessionId === undefined) {
      writeJson(res, 404, { error: { code: "SESSION_NOT_FOUND" } });
      return;
    }
    try {
      await persistent.sessions.open(command.conversationId, command.sessionId);
    } catch {
      writeJson(res, 404, { error: { code: "SESSION_NOT_FOUND" } });
      return;
    }
    if (command.type === CommandTypes.TurnSubmit && command.turnId !== undefined) {
      const conversationId = command.conversationId;
      const key =
        command.idempotencyKey === undefined
          ? command.commandId
          : `${command.conversationId}:${command.idempotencyKey}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        writeJson(res, 202, { kind: "accepted", turnId: existing.turnId });
        return;
      }
      const promise = persistent.sessions.submit(command).then(async (outcome) => {
        if (outcome.kind === "accepted") await persistent.store.maybeAutoTitle(conversationId, command.payload.input);
        return outcome;
      });
      inFlight.set(key, { turnId: command.turnId, promise });
      void promise.catch(() => {}).finally(() => inFlight.delete(key));
      writeJson(res, 202, { kind: "accepted", turnId: command.turnId });
      return;
    }
    const outcome = await persistent.sessions.submit(command);
    writeJson(res, 200, jsonRoundTrip(outcome));
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
