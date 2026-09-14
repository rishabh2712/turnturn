import assert from "node:assert/strict";
import test from "node:test";
import { ConversationStore } from "../dist/store.js";
import { sessionFixture } from "./fixtures.mjs";

function items(view, kind) {
  return view.items.filter((item) => item.kind === kind);
}

test("a fresh store projects an empty conversation with no crash", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.view.items, []);
  assert.equal(snapshot.connection.status, "connecting");
  assert.equal(snapshot.metadata, undefined);
});

test("registering a session and ingesting its records projects into the view", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  await f.startTurn("Hello");
  for (const record of f.records) store.ingestRecord(f.sessionId, record);
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
});

test("ingesting a foreign-session record does not add it, but surfaces a diagnostic", async (t) => {
  const a = await sessionFixture(t);
  const b = await sessionFixture(t, { conversationId: a.conversationId });
  const store = new ConversationStore(a.conversationId);
  store.registerSession(a.sessionId, 0);
  await a.startTurn("A only");
  await b.startTurn("B only");
  for (const record of a.records) store.ingestRecord(a.sessionId, record);
  store.ingestRecord(a.sessionId, b.records[0]);
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["A only"],
  );
  assert.ok(view.diagnostics.some((issue) => issue.code === "foreign-session"));
});

test("redelivering an already-ingested record leaves the snapshot the exact same object", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  await f.startTurn("Hello");
  for (const record of f.records) store.ingestRecord(f.sessionId, record);
  const before = store.getSnapshot();
  store.ingestRecord(f.sessionId, f.records[0]);
  const after = store.getSnapshot();
  assert.equal(after, before);
});

test("calling getSnapshot twice with no mutation between returns the exact same object", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  const first = store.getSnapshot();
  const second = store.getSnapshot();
  assert.equal(first, second);
});

test("subscribers are notified on ingest and not notified after unsubscribing", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  await f.startTurn("Hello");
  store.ingestRecord(f.sessionId, f.records[0]);
  assert.equal(calls, 1);
  unsubscribe();
  store.ingestRecord(f.sessionId, f.records[1]);
  assert.equal(calls, 1);
});

test("an optimistic message appears before the durable turn and disappears once it lands", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  store.setOptimistic(f.sessionId, f.turnId, "Draft");
  const before = store.getSnapshot().view;
  assert.deepEqual(
    items(before, "user-message").map((item) => item.source),
    ["optimistic"],
  );

  await f.startTurn("Draft");
  for (const record of f.records) store.ingestRecord(f.sessionId, record);
  store.clearOptimistic(f.sessionId);
  const after = store.getSnapshot().view;
  assert.deepEqual(
    items(after, "user-message").map((item) => [item.text, item.source]),
    [["Draft", "durable"]],
  );
});

test("setConnection updates the snapshot and notifies, but is a no-op for an identical state", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.setConnection({ status: "connected", serverInstanceId: "srv_1" });
  assert.equal(store.getSnapshot().connection.status, "connected");
  assert.equal(calls, 1);

  store.setConnection({ status: "connected", serverInstanceId: "srv_1" });
  assert.equal(calls, 1);
});

test("setMetadata is reflected in the snapshot without touching the projected view", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  const before = store.getSnapshot();
  store.setMetadata({ conversationId: f.conversationId, title: "Renamed" });
  const after = store.getSnapshot();
  assert.equal(after.metadata?.title, "Renamed");
  assert.equal(after.view, before.view);
});

test("registerSession twice preserves already-ingested records and just updates provider/model", async (t) => {
  const f = await sessionFixture(t, { provider: "anthropic" });
  const store = new ConversationStore(f.conversationId);
  store.registerSession(f.sessionId, 0);
  await f.startTurn("Hello");
  for (const record of f.records) store.ingestRecord(f.sessionId, record);
  store.registerSession(f.sessionId, 0, "anthropic", "claude");
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
});

test("ingesting into an unregistered session lazily creates its slice", async (t) => {
  const f = await sessionFixture(t);
  const store = new ConversationStore(f.conversationId);
  await f.startTurn("Hello");
  for (const record of f.records) store.ingestRecord(f.sessionId, record);
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
});
