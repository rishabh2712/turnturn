import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandTypes, formatCommandId, formatTurnId, SCHEMA_VERSION } from "@turnturn/protocol";
import { createAssistantHttpServer, createAssistantRuntime, createPersistentRuntime } from "../dist/index.js";

test("conversation API creates, lists, activates, renames, archives, and deletes across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-api-test-"));
  let harness;
  try {
    harness = await start(root);
    const wrongKey = await harness.json("/api/conversations", "POST", { workspaceKey: "wrong" });
    assert.equal(wrongKey.status, 400);
    const created = await harness.json("/api/conversations", "POST", { workspaceKey: harness.workspaceKey });
    assert.equal(created.status, 201);
    const id = created.body.conversation.conversationId;
    assert.equal(created.body.conversation.sessions.length, 0);
    const missingEventScope = await harness.json("/events?token=test-token");
    assert.equal(missingEventScope.status, 400);

    const activated = await harness.json(`/api/conversations/${id}/activate`, "POST");
    assert.equal(activated.status, 200);
    assert.equal(activated.body.isNewSession, true);
    const again = await harness.json(`/api/conversations/${id}/activate`, "POST");
    assert.equal(again.body.sessionId, activated.body.sessionId);
    assert.equal(again.body.isNewSession, false);

    const detail = await harness.json(`/api/conversations/${id}`);
    assert.equal(detail.body.sessions.length, 1);
    assert.equal(detail.body.sessions[0].lastSequence, 2);
    const records = await harness.json(
      `/api/conversations/${id}/sessions/${activated.body.sessionId}/records?afterSequence=1`,
    );
    assert.deepEqual(
      records.body.records.map((record) => record.sequence),
      [2],
    );
    assert.equal(records.body.lastSequence, 2);
    assert.equal(records.body.hasMore, false);
    const other = await harness.json("/api/conversations", "POST", { workspaceKey: harness.workspaceKey });
    const crossed = await harness.json(
      `/api/conversations/${other.body.conversation.conversationId}/sessions/${activated.body.sessionId}/records`,
    );
    assert.equal(crossed.status, 404);
    assert.equal(crossed.body.error.code, "SESSION_NOT_IN_CONVERSATION");
    const listed = await harness.json("/api/conversations");
    assert.equal(listed.body.conversations.find((item) => item.conversationId === id).sessionCount, 1);

    const refused = await harness.json(`/api/conversations/${id}`, "DELETE");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "CONVERSATION_NOT_ARCHIVED");
    await harness.json(`/api/conversations/${id}`, "PATCH", { title: "Manual name", archived: true });
    await harness.close();
    harness = await start(root);
    const archived = await harness.json("/api/conversations?archived=true");
    assert.equal(archived.body.conversations[0].title, "Manual name");
    assert.equal((await harness.json(`/api/conversations/${id}`, "DELETE")).status, 204);
  } finally {
    if (harness) await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("turn submission returns before the saved session finishes and later replays its terminal record", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-api-turn-test-"));
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = {
    name: "blocked-test",
    async *run() {
      await gate;
      yield { type: "completed", reason: "complete" };
    },
  };
  const harness = await start(root, provider);
  try {
    const created = await harness.json("/api/conversations", "POST", { workspaceKey: harness.workspaceKey });
    const conversationId = created.body.conversation.conversationId;
    const session = await harness.json(`/api/conversations/${conversationId}/activate`, "POST");
    const sessionId = session.body.sessionId;
    const turnId = formatTurnId(randomUUID());
    const submitted = {
      schemaVersion: SCHEMA_VERSION,
      commandId: formatCommandId(randomUUID()),
      idempotencyKey: "same-turn",
      type: CommandTypes.TurnSubmit,
      createdAt: new Date().toISOString(),
      conversationId,
      sessionId,
      turnId,
      payload: { input: "persist me" },
    };
    const accepted = await harness.json("/commands", "POST", submitted);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.turnId, turnId);
    const duplicate = await harness.json("/commands", "POST", {
      ...submitted,
      commandId: formatCommandId(randomUUID()),
      turnId: formatTurnId(randomUUID()),
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.turnId, turnId);
    const path = `/api/conversations/${conversationId}/sessions/${sessionId}/records`;
    const running = await harness.json(path);
    assert.equal(
      running.body.records.some((record) => record.type === "turn.completed"),
      false,
    );
    release();
    let terminal;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      terminal = await harness.json(path);
      if (terminal.body.records.some((record) => record.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      terminal.body.records.some((record) => record.type === "turn.completed"),
      true,
    );
  } finally {
    release();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config omits credentials and file peek confines text and size", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-api-read-test-"));
  const harness = await start(root, undefined, {
    apiKey: "sensitive-key",
    baseUrl: "https://user:secret@example.com/path",
  });
  try {
    const runtime = await harness.json("/api/runtime");
    assert.equal(runtime.body.baseUrlHost, "example.com");
    assert.equal(runtime.body.workspace.key, harness.workspaceKey);
    assert.equal(
      runtime.body.tools.some((tool) => tool.name === "read"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(runtime.body), /sensitive-key|user:secret/);

    await mkdir(join(harness.workspace, "src"), { recursive: true });
    await writeFile(join(harness.workspace, "src", "a.ts"), "first\nsecond\nthird");
    await writeFile(join(root, "secret.txt"), "outside");
    await writeFile(join(harness.workspace, "binary"), Buffer.from([0xff]));
    await writeFile(join(harness.workspace, "large"), Buffer.alloc(1024 * 1024 + 1, 97));
    const base = `/api/workspaces/${harness.workspaceKey}/file?path=`;
    const good = await harness.json(`${base}src/a.ts&start=2&end=2`);
    assert.equal(good.body.content, "second");
    assert.equal((await harness.json(`${base}../secret.txt`)).status, 403);
    assert.equal((await harness.json(`${base}binary`)).status, 415);
    assert.equal((await harness.json(`${base}large`)).status, 413);

    const created = await harness.json("/api/conversations", "POST", { workspaceKey: harness.workspaceKey });
    const id = created.body.conversation.conversationId;
    const session = await harness.json(`/api/conversations/${id}/activate`, "POST");
    const debug = await harness.json(`/api/debug/state?conversationId=${id}&sessionId=${session.body.sessionId}`);
    assert.equal(debug.status, 200);
    assert.deepEqual(debug.body.engineStateIssues, []);
    assert.deepEqual(debug.body.providerHistoryIssues, []);
    assert.doesNotMatch(JSON.stringify(debug.body), /sensitive-key/);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function start(root, provider, config = {}) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runtime = createAssistantRuntime({ workspace, provider: "ollama", model: "test", ...config });
  if (provider !== undefined) runtime.provider = provider;
  const persistent = await createPersistentRuntime(runtime, { stateRoot: join(root, "state") });
  const server = createAssistantHttpServer({ runtime, persistent, token: "test-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    workspaceKey: persistent.state.workspaceKey,
    workspace,
    json: async (path, method = "GET", body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { "x-turnturn-token": "test-token", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    close: async () => {
      server.close();
      await once(server, "close");
      await persistent.close();
    },
  };
}
