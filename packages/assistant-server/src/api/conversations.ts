import type { IncomingMessage, ServerResponse } from "node:http";
import { type ConversationId, parseId, type SessionId } from "@turnturn/protocol";
import { writeJson } from "../json.js";
import type { PersistentRuntime } from "../persistent-runtime.js";

export async function handleConversationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: PersistentRuntime,
): Promise<boolean> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "conversations") return false;
  const method = req.method ?? "GET";
  if (parts.length === 2) {
    if (method === "GET") {
      const archived = url.searchParams.get("archived") === "true";
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100));
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      if (!Number.isSafeInteger(offset) || offset < 0) return error(res, 400, "INVALID_CURSOR");
      const all = await runtime.store.list({ archived });
      const conversations = await Promise.all(
        all.slice(offset, offset + limit).map(async (entry) => ({
          ...entry,
          sessionCount: (await runtime.store.get(entry.conversationId))?.sessions.length ?? 0,
        })),
      );
      writeJson(res, 200, {
        conversations,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
      return true;
    }
    if (method === "POST") {
      const body = await readObject(req, res);
      if (body === null) return true;
      if (body.workspaceKey !== runtime.state.workspaceKey) return error(res, 400, "WORKSPACE_KEY_MISMATCH");
      if (body.title !== undefined && typeof body.title !== "string") return error(res, 400, "INVALID_TITLE");
      const conversation = await runtime.store.create(body.title as string | undefined);
      writeJson(res, 201, { conversation });
      return true;
    }
    return false;
  }
  let conversationId: ConversationId;
  try {
    conversationId = parseId("conv", parts[2] ?? "");
  } catch {
    return error(res, 400, "INVALID_CONVERSATION_ID");
  }
  const conversation = await runtime.store.get(conversationId);
  if (conversation === undefined) return error(res, 404, "CONVERSATION_NOT_FOUND");

  if (parts.length === 6 && parts[3] === "sessions" && parts[5] === "records" && method === "GET") {
    let sessionId: SessionId;
    try {
      sessionId = parseId("sess", parts[4] ?? "");
    } catch {
      return error(res, 404, "SESSION_NOT_IN_CONVERSATION");
    }
    if (!conversation.sessions.some((session) => session.sessionId === sessionId)) {
      return error(res, 404, "SESSION_NOT_IN_CONVERSATION");
    }
    const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "1000");
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      return error(res, 400, "INVALID_RECORD_CURSOR");
    }
    const opened = await runtime.sessions.open(conversationId, sessionId);
    const all = opened.durable.records();
    const remaining = all.filter((record) => record.sequence > afterSequence);
    writeJson(res, 200, {
      sessionId,
      records: remaining.slice(0, limit),
      lastSequence: all.at(-1)?.sequence ?? 0,
      hasMore: remaining.length > limit,
    });
    return true;
  }

  if (parts.length === 3 && method === "GET") {
    const sessions = await Promise.all(
      conversation.sessions.map(async (session) => {
        const opened = await runtime.sessions.open(conversationId, session.sessionId);
        return { ...session, lastSequence: opened.durable.records().at(-1)?.sequence ?? 0 };
      }),
    );
    writeJson(res, 200, { conversation, sessions });
    return true;
  }
  if (parts.length === 4 && parts[3] === "activate" && method === "POST") {
    const session = await runtime.store.activate(conversationId);
    await runtime.sessions.open(conversationId, session.sessionId);
    writeJson(res, 200, session);
    return true;
  }
  if (parts.length === 3 && method === "PATCH") {
    const body = await readObject(req, res);
    if (body === null) return true;
    if (body.title !== undefined && typeof body.title !== "string") return error(res, 400, "INVALID_TITLE");
    if (body.archived !== undefined && typeof body.archived !== "boolean") return error(res, 400, "INVALID_ARCHIVED");
    if (body.archived === true && runtime.sessions.isConversationBusy(conversationId)) {
      return error(res, 409, "CONVERSATION_BUSY");
    }
    if (typeof body.title === "string") await runtime.store.rename(conversationId, body.title);
    if (body.archived === true) await runtime.store.archive(conversationId);
    if (body.archived === false) await runtime.store.unarchive(conversationId);
    writeJson(res, 200, { conversation: await runtime.store.get(conversationId) });
    return true;
  }
  if (parts.length === 3 && method === "DELETE") {
    if (runtime.sessions.isConversationBusy(conversationId)) return error(res, 409, "CONVERSATION_BUSY");
    if (!conversation.archived) return error(res, 409, "CONVERSATION_NOT_ARCHIVED");
    await runtime.store.delete(conversationId);
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return true;
  }
  return false;
}

async function readObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
    return value as Record<string, unknown>;
  } catch {
    error(res, 400, "INVALID_JSON");
    return null;
  }
}

function error(res: ServerResponse, status: number, code: string): true {
  writeJson(res, status, { error: { code, message: code } });
  return true;
}
