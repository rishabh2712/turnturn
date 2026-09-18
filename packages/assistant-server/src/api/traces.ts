import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type ConversationId, parseId, type SessionId, type TurnId } from "@turnturn/protocol";
import { writeJson } from "../json.js";
import {
  type ReadTraceBundleResult,
  readTraceBundle,
  readTracePayload,
  reduceTraceBundle,
  traceRootForSessionLog,
} from "../observability/index.js";
import type { PersistentRuntime } from "../persistent-runtime.js";

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function handleTraceApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: PersistentRuntime,
): Promise<boolean> {
  if (req.method !== "GET") return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "conversations" || parts[3] !== "sessions" || parts[5] !== "traces") {
    return false;
  }

  let conversationId: ConversationId;
  let sessionId: SessionId;
  try {
    conversationId = parseId("conv", parts[2] ?? "");
    sessionId = parseId("sess", parts[4] ?? "");
  } catch {
    return error(res, 404, "TRACE_NOT_FOUND");
  }
  const conversation = await runtime.store.get(conversationId);
  if (conversation === undefined || !conversation.sessions.some((session) => session.sessionId === sessionId)) {
    return error(res, 404, "TRACE_NOT_FOUND");
  }
  const sessionLog = runtime.store.sessionPath(conversationId, sessionId);
  const tracesRoot = traceRootForSessionLog(sessionLog);

  if (parts.length === 6) {
    let turnId: TurnId | undefined;
    const requestedTurn = url.searchParams.get("turnId");
    try {
      turnId = requestedTurn === null ? undefined : parseId("turn", requestedTurn);
    } catch {
      return error(res, 400, "INVALID_TURN_ID");
    }
    const summaries = [];
    for (const traceId of await traceDirectories(tracesRoot)) {
      try {
        const bundle = await readTraceBundle(join(tracesRoot, traceId));
        if (turnId !== undefined && bundle.manifest.turnId !== turnId) continue;
        const reduced = reduceTraceBundle(bundle);
        summaries.push({
          traceId: bundle.manifest.traceId,
          turnId: bundle.manifest.turnId,
          capturedAt: bundle.manifest.capturedAt,
          provider: bundle.manifest.provider,
          model: bundle.manifest.model,
          status: reduced.turns[0]?.status ?? "unknown",
          lastTraceSequence: bundle.envelopes.at(-1)?.traceSequence ?? 0,
          issueCount: reduced.issues.length,
        });
      } catch {
        // A malformed diagnostic bundle must not prevent other traces from being listed.
      }
    }
    summaries.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    writeJson(res, 200, { traces: summaries });
    return true;
  }

  const traceId = parts[6] ?? "";
  if (!SAFE_TRACE_ID.test(traceId)) return error(res, 404, "TRACE_NOT_FOUND");
  const bundlePath = join(tracesRoot, traceId);
  let bundle: ReadTraceBundleResult;
  try {
    bundle = await readTraceBundle(bundlePath);
  } catch {
    return error(res, 404, "TRACE_NOT_FOUND");
  }
  if (
    bundle.manifest.traceId !== traceId ||
    bundle.manifest.conversationId !== conversationId ||
    bundle.manifest.sessionId !== sessionId
  ) {
    return error(res, 404, "TRACE_NOT_FOUND");
  }

  if (parts.length === 7) {
    const afterTraceSequence = Number(url.searchParams.get("afterTraceSequence") ?? "0");
    if (!Number.isSafeInteger(afterTraceSequence) || afterTraceSequence < 0) {
      return error(res, 400, "INVALID_TRACE_CURSOR");
    }
    const lastTraceSequence = bundle.envelopes.at(-1)?.traceSequence ?? 0;
    writeJson(res, 200, {
      traceId,
      lastTraceSequence,
      unchanged: lastTraceSequence <= afterTraceSequence,
      ...(lastTraceSequence <= afterTraceSequence ? {} : { trace: reduceTraceBundle(bundle) }),
    });
    return true;
  }

  if (parts.length === 9 && parts[7] === "payloads") {
    const payloadId = parts[8] ?? "";
    if (!SAFE_TRACE_ID.test(payloadId) || !bundle.envelopes.some((event) => event.payloadRef === payloadId)) {
      return error(res, 404, "TRACE_PAYLOAD_NOT_FOUND");
    }
    try {
      writeJson(res, 200, { payloadId, value: await readTracePayload(bundlePath, payloadId) });
    } catch {
      return error(res, 404, "TRACE_PAYLOAD_NOT_FOUND");
    }
    return true;
  }

  return false;
}

async function traceDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SAFE_TRACE_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

function error(res: ServerResponse, status: number, code: string): true {
  writeJson(res, status, { error: { code, message: code } });
  return true;
}
