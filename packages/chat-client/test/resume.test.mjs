import assert from "node:assert/strict";
import test from "node:test";
import { LiveEventTypes as Live } from "@turnturn/protocol";
import { resumeConversation } from "../dist/resume.js";
import { ConversationStore } from "../dist/store.js";
import { createFakeTransport } from "./fake-transport.mjs";
import { Durable, sessionFixture } from "./fixtures.mjs";

function items(view, kind) {
  return view.items.filter((item) => item.kind === kind);
}

// resume.ts's snapshot handling is async (it awaits getRecords), so tests need to let
// that chain settle before asserting on the store.
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a snapshot triggers catch-up of every record the store doesn't have yet", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Hello");
  const transport = createFakeTransport(f.conversationId);
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);

  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
  assert.equal(store.getSnapshot().connection.status, "connected");
  controller.stop();
});

test("catch-up only fetches what's missing, not records the store already has", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Hello");
  const transport = createFakeTransport(f.conversationId);
  const store = new ConversationStore(f.conversationId);
  // Simulate the store already having the first record, and only the rest sitting on
  // the "server" — catch-up must ask for afterSequence=1, not afterSequence=0.
  store.ingestRecord(f.sessionId, f.records[0]);
  transport.seedRecords(f.sessionId, f.records.slice(1));

  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
  controller.stop();
});

test("catch-up pages through multiple round trips when the server limits page size", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Hello");
  await f.startStep();
  const transport = createFakeTransport(f.conversationId, { pageLimit: 2 });
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);

  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  assert.equal(store.lastSequenceFor(f.sessionId), f.records.at(-1).sequence);
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["Hello"],
  );
  controller.stop();
});

test("a server restart (different serverInstanceId) clears live state but keeps durable records", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  const transport = createFakeTransport(f.conversationId, { serverInstanceId: "srv_1" });
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);

  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const delta = f.event(Live.ContentDelta, { text: "streaming" }, { turnId: f.turnId, stepId: f.stepId });
  transport.emitEvent(delta);
  const streaming = store.getSnapshot().view;
  assert.deepEqual(
    items(streaming, "assistant-message").map((item) => [item.text, item.source]),
    [["streaming", "live"]],
  );

  transport.setServerInstanceId("srv_2");
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const afterRestart = store.getSnapshot().view;
  assert.deepEqual(items(afterRestart, "assistant-message"), []);
  controller.stop();
});

test("the very first snapshot (no prior serverInstanceId) never clears live state", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  const transport = createFakeTransport(f.conversationId, { serverInstanceId: "srv_1" });
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);

  const delta = f.event(Live.ContentDelta, { text: "before any snapshot" }, { turnId: f.turnId, stepId: f.stepId });
  store.ingestLive(f.sessionId, delta);

  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "assistant-message").map((item) => item.text),
    ["before any snapshot"],
  );
  controller.stop();
});

test("live events are forwarded to the store as they arrive", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  const transport = createFakeTransport(f.conversationId);
  const store = new ConversationStore(f.conversationId);
  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: 0 }]);
  await flush();

  const delta = f.event(Live.ContentDelta, { text: "hi" }, { turnId: f.turnId, stepId: f.stepId });
  transport.emitEvent(delta);
  const view = store.getSnapshot().view;
  assert.deepEqual(
    items(view, "assistant-message").map((item) => item.text),
    ["hi"],
  );
  controller.stop();
});

test("a live event with no sessionId is dropped rather than crashing", async (t) => {
  const f = await sessionFixture(t);
  const transport = createFakeTransport(f.conversationId);
  const store = new ConversationStore(f.conversationId);
  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([]);
  await flush();

  assert.doesNotThrow(() => {
    transport.emitEvent({
      schemaVersion: 1,
      eventId: "evt_x",
      type: Live.Warning,
      createdAt: new Date().toISOString(),
      conversationId: f.conversationId,
      payload: { message: "global warning" },
    });
  });
  controller.stop();
});

test("onError sets the connection to reconnecting without touching the view", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Hello");
  const transport = createFakeTransport(f.conversationId);
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);
  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  const before = store.getSnapshot().view;
  transport.emitError(new Error("network blip"));
  const after = store.getSnapshot();
  assert.equal(after.connection.status, "reconnecting");
  assert.equal(after.view, before);
  controller.stop();
});

test("stop() halts further replay and live forwarding", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Hello");
  const transport = createFakeTransport(f.conversationId);
  transport.seedRecords(f.sessionId, f.records);
  const store = new ConversationStore(f.conversationId);
  const controller = resumeConversation(transport, store, f.conversationId);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  controller.stop();
  assert.equal(transport.isSubscribed(), false);

  const before = store.getSnapshot();
  const delta = f.event(Live.ContentDelta, { text: "after stop" }, { turnId: f.turnId, stepId: f.stepId });
  transport.emitEvent(delta); // no-op: handlers were cleared by unsubscribe
  assert.equal(store.getSnapshot(), before);
});

test("golden: reconnecting after missing part of a turn matches a client that never disconnected", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("Investigate");
  await f.startStep();

  // Reference client: ingests every record directly as it's produced. Never
  // disconnects, never touches the transport at all.
  const reference = new ConversationStore(f.conversationId);
  for (const record of f.records) reference.ingestRecord(f.sessionId, record);

  // Client under test: connects, catches up to the point of disconnect, then the
  // connection drops before the rest of the turn's records exist on the "server".
  const transport = createFakeTransport(f.conversationId);
  const underTest = new ConversationStore(f.conversationId);
  const controller = resumeConversation(transport, underTest, f.conversationId);
  transport.seedRecords(f.sessionId, f.records);
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();
  transport.emitError(new Error("dropped"));

  // The turn keeps going while the client is dark: more durable records are
  // produced, and the reference client (which "never disconnected") sees them
  // directly.
  const toolCallId = f.toolCallId();
  await f.add(
    Durable.ToolRequested,
    { name: "read", input: { path: "a.ts" }, providerOrder: 0, requiresApproval: false },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(
    Durable.ToolResultCompleted,
    { output: { path: "a.ts", content: "x" } },
    { turnId: f.turnId, toolCallId },
  );
  await f.add(Durable.ProviderStepCompleted, { stopReason: "complete" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(Durable.AssistantMessageCompleted, { content: "Done" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(Durable.TurnCompleted, { stopReason: "complete" }, { turnId: f.turnId });
  for (const record of f.records.slice(-5)) reference.ingestRecord(f.sessionId, record);

  // The client under test reconnects: a fresh snapshot with the caught-up
  // lastSequence, and the newly produced records now available to fetch.
  transport.seedRecords(f.sessionId, f.records.slice(-5));
  transport.emitSnapshot([{ sessionId: f.sessionId, lastSequence: f.records.at(-1).sequence }]);
  await flush();

  assert.deepEqual(underTest.getSnapshot().view.items, reference.getSnapshot().view.items);
  assert.deepEqual(underTest.getSnapshot().view.diagnostics, reference.getSnapshot().view.diagnostics);
  controller.stop();
});
