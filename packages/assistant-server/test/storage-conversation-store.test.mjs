import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationStore } from "../dist/storage/conversation-store.js";
import { openStateDirectory } from "../dist/storage/state-dir.js";

test("conversation identity and same-model session activation survive reopen", async () => {
  await withState(async (state) => {
    const store = await ConversationStore.open(state, { provider: "ollama", model: "model-a" });
    const conversation = await store.create();
    assert.equal(conversation.title, null);
    assert.deepEqual(conversation.sessions, []);

    const first = await store.activate(conversation.conversationId);
    const reused = await store.activate(conversation.conversationId);
    assert.equal(first.isNewSession, true);
    assert.equal(reused.isNewSession, false);
    assert.equal(first.sessionId, reused.sessionId);
    assert.equal(first.ordinal, 1);

    const changedModel = await ConversationStore.open(state, { provider: "ollama", model: "model-b" });
    const second = await changedModel.activate(conversation.conversationId);
    assert.equal(second.isNewSession, true);
    assert.equal(second.ordinal, 2);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.match(changedModel.sessionPath(conversation.conversationId, second.sessionId), /000002-sess_/);

    const reopened = await ConversationStore.open(state, { provider: "ollama", model: "model-b" });
    assert.deepEqual(
      (await reopened.get(conversation.conversationId)).sessions.map((session) => session.sessionId),
      [first.sessionId, second.sessionId],
    );
    assert.equal((await reopened.activate(conversation.conversationId)).isNewSession, false);
  });
});

test("first-message title is durable and a manual rename is never overwritten", async () => {
  await withState(async (state) => {
    const store = await ConversationStore.open(state, { provider: "ollama", model: "model" });
    const first = await store.create();
    await store.maybeAutoTitle(first.conversationId, "\n  **Fix** the failing test in src/app.ts, please  ");
    assert.equal((await store.get(first.conversationId)).title, "Fix the failing test in src/app.ts, please");
    await store.rename(first.conversationId, "My investigation");
    await store.maybeAutoTitle(first.conversationId, "A later request");

    const reopened = await ConversationStore.open(state, { provider: "ollama", model: "model" });
    assert.equal((await reopened.get(first.conversationId)).title, "My investigation");
    assert.equal((await reopened.get(first.conversationId)).titleSource, "manual");
    await unlink(join(state.workspaceDir, "conversations", "index.jsonl"));
    const rebuilt = await ConversationStore.open(state, { provider: "ollama", model: "model" });
    assert.equal((await rebuilt.get(first.conversationId)).title, "My investigation");
  });
});

test("archive hides a conversation, unarchive restores it, and deletion requires archive", async () => {
  await withState(async (state) => {
    const store = await ConversationStore.open(state, { provider: "ollama", model: "model" });
    const conversation = await store.create();
    await assert.rejects(store.delete(conversation.conversationId), /archive/i);
    await store.archive(conversation.conversationId);
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ archived: true })).length, 1);
    await store.unarchive(conversation.conversationId);
    assert.equal((await store.list()).length, 1);
    await store.archive(conversation.conversationId);
    await store.delete(conversation.conversationId);
    assert.equal(await store.get(conversation.conversationId), undefined);
    assert.equal((await store.list({ archived: true })).length, 0);
  });
});

async function withState(run) {
  const root = await mkdtemp(join(tmpdir(), "turnturn-store-test-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspace);
  try {
    const state = await openStateDirectory({ workspace, stateRoot });
    try {
      await run(state);
    } finally {
      await state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
