import { open, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { WorkspacePathGuard } from "@turnturn/assistant-core/workspace-tools";
import { parseId } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { writeJson } from "../json.js";
import type { PersistentRuntime } from "../persistent-runtime.js";
import type { AssistantRuntime } from "../runtime.js";
import { STORAGE_VERSION } from "../storage/state-dir.js";

const MAX_FILE_BYTES = 1024 * 1024;

export async function handleReadOnlyApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: AssistantRuntime,
  persistent: PersistentRuntime,
): Promise<boolean> {
  if (req.method !== "GET") return false;
  if (url.pathname === "/api/runtime") {
    let baseUrlHost: string | null = null;
    if (runtime.config.baseUrl !== undefined) {
      try {
        baseUrlHost = new URL(runtime.config.baseUrl).host;
      } catch {
        baseUrlHost = null;
      }
    }
    writeJson(res, 200, {
      workspace: {
        key: persistent.state.workspaceKey,
        path: persistent.state.workspacePath,
        name: basename(persistent.state.workspacePath),
      },
      provider: runtime.config.provider,
      model: runtime.config.model,
      baseUrlHost,
      maxTokens: runtime.config.maxTokens ?? null,
      serverInstanceId: persistent.serverInstanceId,
      storageVersion: STORAGE_VERSION,
      schemaVersion: 1,
      tools: runtime.tools.definitions().map((tool) => ({
        name: tool.name,
        description: tool.description,
        mutating: tool.mutating,
      })),
    });
    return true;
  }

  const fileMatch = /^\/api\/workspaces\/([^/]+)\/file$/.exec(url.pathname);
  if (fileMatch !== null) {
    if (fileMatch[1] !== persistent.state.workspaceKey) return error(res, 404, "WORKSPACE_NOT_FOUND");
    const path = url.searchParams.get("path");
    const start = Number(url.searchParams.get("start") ?? "1");
    const end = Number(url.searchParams.get("end") ?? "200");
    if (
      !path ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start > 199
    ) {
      return error(res, 400, "INVALID_FILE_RANGE");
    }
    try {
      const guard = new WorkspacePathGuard({
        roots: [persistent.state.workspacePath],
        defaultRoot: persistent.state.workspacePath,
      });
      const confined = await guard.existingFile(path);
      const size = (await stat(confined.absolute)).size;
      if (size > MAX_FILE_BYTES) return error(res, 413, "TOO_LARGE");
      const handle = await open(confined.absolute, "r");
      let bytes: Buffer;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return error(res, 415, "NOT_TEXT");
      }
      if (text.includes("\0")) return error(res, 415, "NOT_TEXT");
      const lines = text.split(/\r?\n/);
      writeJson(res, 200, {
        path: confined.relative,
        start,
        end: Math.min(end, lines.length),
        lineCount: lines.length,
        content: lines.slice(start - 1, end).join("\n"),
      });
      return true;
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
      if (code === "PATH_OUTSIDE_WORKSPACE") return error(res, 403, "PATH_OUTSIDE_WORKSPACE");
      if (code === "ENOENT") return error(res, 404, "FILE_NOT_FOUND");
      return error(res, 400, "INVALID_FILE_PATH");
    }
  }

  if (url.pathname === "/api/debug/state") {
    try {
      const conversationId = parseId("conv", url.searchParams.get("conversationId") ?? "");
      const sessionId = parseId("sess", url.searchParams.get("sessionId") ?? "");
      const opened = await persistent.sessions.open(conversationId, sessionId);
      const records = opened.durable.records();
      writeJson(res, 200, {
        engineStateIssues: reduceEngineState(records).issues,
        providerHistoryIssues: reduceProviderHistory(records).issues,
        lastSequence: records.at(-1)?.sequence ?? 0,
      });
    } catch {
      return error(res, 404, "SESSION_NOT_IN_CONVERSATION");
    }
    return true;
  }
  return false;
}

function error(res: ServerResponse, status: number, code: string): true {
  writeJson(res, status, { error: { code, message: code } });
  return true;
}
