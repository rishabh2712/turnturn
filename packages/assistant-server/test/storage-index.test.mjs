import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationIndex } from "../dist/storage/conversation-index.js";

test("index folds lifecycle events in file order and derives activity from session mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-index-test-"));
  const conversations = join(root, "conversations");
  const conversationId = "conv_018f1f4e-8d5f-7abc-8123-823456789001";
  try {
    const index = await ConversationIndex.open(root);
    await index.append({
      type: "created",
      conversationId,
      workspaceKey: "workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await index.append({ type: "titled", conversationId, title: "Automatic", titleSource: "auto" });
    await index.append({ type: "titled", conversationId, title: "Manual", titleSource: "manual" });
    await index.append({ type: "archived", conversationId });
    await index.append({ type: "unarchived", conversationId });
    const sessionDir = join(conversations, conversationId, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "000001-sess_018f1f4e-8d5f-7abc-8123-823456789002.jsonl");
    await writeFile(sessionFile, "session records are never read by listing\n");

    const [entry] = await index.list();
    assert.equal(entry.title, "Manual");
    assert.equal(entry.titleSource, "manual");
    assert.equal(entry.archived, false);
    assert.ok(Math.abs(Date.parse(entry.lastActivityAt) - (await stat(sessionFile)).mtimeMs) < 2);
    assert.equal((await ConversationIndex.open(root)).get(conversationId).title, "Manual");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index compacts after 5000 lines without changing its folded view", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-index-test-"));
  const conversationId = "conv_018f1f4e-8d5f-7abc-8123-823456789003";
  try {
    const index = await ConversationIndex.open(root);
    await index.append({
      type: "created",
      conversationId,
      workspaceKey: "workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    for (let n = 0; n < 5000; n += 1) {
      await index.append({ type: "titled", conversationId, title: `Title ${n}`, titleSource: "manual" });
    }
    const lines = (await readFile(join(root, "conversations", "index.jsonl"), "utf8")).trim().split("\n");
    assert.ok(lines.length < 5001);
    assert.equal(index.get(conversationId).title, "Title 4999");
    assert.equal((await ConversationIndex.open(root)).get(conversationId).title, "Title 4999");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing or invalid index rebuilds from conversation metadata without touching session logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-index-test-"));
  const conversationId = "conv_018f1f4e-8d5f-7abc-8123-823456789004";
  const conversationDir = join(root, "conversations", conversationId);
  const sessionDir = join(conversationDir, "sessions");
  const sessionFile = join(sessionDir, "000001-sess_018f1f4e-8d5f-7abc-8123-823456789005.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(conversationDir, "conversation.json"),
    JSON.stringify({
      conversationId,
      workspaceKey: "workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      storageVersion: 1,
      title: "Saved title",
      titleSource: "manual",
      archived: false,
    }),
  );
  await writeFile(sessionFile, "original bytes\n");
  try {
    const first = await ConversationIndex.open(root);
    assert.equal(first.get(conversationId).title, "Saved title");
    await writeFile(join(root, "conversations", "index.jsonl"), "not json\n");
    const second = await ConversationIndex.open(root);
    assert.equal(second.get(conversationId).title, "Saved title");
    assert.equal(await readFile(sessionFile, "utf8"), "original bytes\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart listing 200 conversations stays independent of 500-record session payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-index-scale-"));
  const conversations = join(root, "conversations");
  try {
    const index = await ConversationIndex.open(root);
    const ids = Array.from({ length: 200 }, (_, n) => `conv_018f1f4e-8d5f-7abc-8123-${String(n).padStart(12, "0")}`);
    for (const conversationId of ids) {
      await index.append({
        type: "created",
        conversationId,
        workspaceKey: "workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const dir = join(conversations, conversationId, "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "000001-sess_018f1f4e-8d5f-7abc-8123-823456789001.jsonl"),
        "invalid payload\n".repeat(500),
      );
    }

    const started = performance.now();
    const reopened = await ConversationIndex.open(root);
    const listed = await reopened.list();
    const elapsedMs = performance.now() - started;
    assert.equal(listed.length, 200);
    assert.deepEqual(new Set(listed.map((entry) => entry.conversationId)), new Set(ids));
    assert.ok(elapsedMs < 3000, `listing took ${elapsedMs.toFixed(0)}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
