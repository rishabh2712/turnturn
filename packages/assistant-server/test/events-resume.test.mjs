import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandTypes, formatCommandId, formatTurnId, LiveEventTypes, SCHEMA_VERSION } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { createAssistantHttpServer, createAssistantRuntime, createPersistentRuntime } from "../dist/index.js";

test("an event published while the snapshot cursor is collected is not lost", async () => {
  const harness = await start();
  try {
    const conversation = await harness.persistent.store.create();
    const session = await harness.persistent.store.activate(conversation.conversationId);
    const opened = await harness.persistent.sessions.open(conversation.conversationId, session.sessionId);
    const originalRecords = opened.durable.records.bind(opened.durable);
    let published = false;
    opened.durable.records = () => {
      if (!published) {
        published = true;
        harness.runtime.live.publish({
          schemaVersion: SCHEMA_VERSION,
          eventId: harness.runtime.ids.eventId(),
          type: LiveEventTypes.ContentDelta,
          createdAt: harness.runtime.clock.now(),
          conversationId: conversation.conversationId,
          sessionId: session.sessionId,
          payload: { text: "at the subscription boundary" },
        });
      }
      return originalRecords();
    };

    const stream = await openEvents(
      harness.url(`/events?conversationId=${conversation.conversationId}&token=test-token`),
    );
    try {
      const snapshot = await stream.next();
      assert.equal(snapshot.event, "snapshot");
      assert.equal(snapshot.data.sessions[0].lastSequence, 2);
      const live = await stream.next();
      assert.equal(live.event, LiveEventTypes.ContentDelta);
      assert.equal(live.data.payload.text, "at the subscription boundary");
      assert.equal(published, true);
      assert.deepEqual(reduceEngineState(originalRecords()).issues, []);
    } finally {
      await stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("snapshot replay observes every record once across two concurrent sessions", async () => {
  let entered = 0;
  let announceBoth;
  const bothEntered = new Promise((resolve) => {
    announceBoth = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = {
    name: "gated-test",
    async *run() {
      entered += 1;
      if (entered === 2) announceBoth();
      await gate;
      yield { type: "text-delta", text: "done" };
      yield { type: "completed", reason: "complete" };
    },
  };
  const harness = await start(provider);
  const streams = [];
  try {
    const pairs = await Promise.all([createSession(harness), createSession(harness)]);
    for (const pair of pairs) {
      const stream = await openEvents(harness.url(`/events?conversationId=${pair.conversationId}&token=test-token`));
      streams.push(stream);
      const snapshot = await stream.next();
      assert.equal(snapshot.event, "snapshot");
      assert.equal(snapshot.data.conversationId, pair.conversationId);
      assert.deepEqual(snapshot.data.sessions, [{ sessionId: pair.sessionId, lastSequence: 2 }]);
      pair.snapshotSequence = snapshot.data.sessions[0].lastSequence;
    }

    const submissions = await Promise.all(pairs.map((pair) => harness.post("/commands", turn(pair))));
    assert.deepEqual(
      submissions.map((response) => response.status),
      [202, 202],
    );
    await bothEntered;
    release();

    for (const [index, pair] of pairs.entries()) {
      const stream = streams[index];
      const buffered = [];
      while (!buffered.some((frame) => frame.event === LiveEventTypes.TurnCompleted)) {
        buffered.push(await stream.next());
      }
      assert.ok(buffered.every((frame) => frame.data.conversationId === pair.conversationId));
      assert.ok(buffered.some((frame) => frame.event === LiveEventTypes.ContentDelta));

      const path = `/api/conversations/${pair.conversationId}/sessions/${pair.sessionId}/records`;
      const replayResponse = await harness.get(`${path}?afterSequence=0`);
      const laterResponse = await harness.get(`${path}?afterSequence=${pair.snapshotSequence}`);
      const replayAtSnapshot = replayResponse.body.records.filter((record) => record.sequence <= pair.snapshotSequence);
      const observed = [...replayAtSnapshot, ...laterResponse.body.records];
      const final = replayResponse.body.records;
      assert.deepEqual(
        observed.map((record) => record.recordId),
        final.map((record) => record.recordId),
      );
      assert.equal(new Set(observed.map((record) => record.recordId)).size, final.length);
      assert.deepEqual(
        final.map((record) => record.sequence),
        final.map((_, index) => index + 1),
      );
      assert.ok(final.every((record) => record.conversationId === pair.conversationId));
      assert.ok(final.every((record) => record.sessionId === pair.sessionId));
      assert.deepEqual(reduceEngineState(final).issues, []);
    }
  } finally {
    release();
    await Promise.all(streams.map((stream) => stream.close()));
    await harness.close();
  }
});

async function start(provider) {
  const root = await mkdtemp(join(tmpdir(), "turnturn-events-resume-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = createAssistantRuntime({ workspace, provider: "ollama", model: "test" });
  if (provider !== undefined) runtime.provider = provider;
  const persistent = await createPersistentRuntime(runtime, { stateRoot: join(root, "state") });
  const server = createAssistantHttpServer({ runtime, persistent, token: "test-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    runtime,
    persistent,
    url: (path) => `${base}${path}`,
    get: async (path) => {
      const response = await fetch(`${base}${path}`, { headers: { "x-turnturn-token": "test-token" } });
      return { status: response.status, body: await response.json() };
    },
    post: async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "x-turnturn-token": "test-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      server.close();
      await once(server, "close");
      await persistent.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createSession(harness) {
  const conversation = await harness.persistent.store.create();
  const session = await harness.persistent.store.activate(conversation.conversationId);
  await harness.persistent.sessions.open(conversation.conversationId, session.sessionId);
  return { conversationId: conversation.conversationId, sessionId: session.sessionId, snapshotSequence: 0 };
}

function turn(pair) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: formatCommandId(randomUUID()),
    type: CommandTypes.TurnSubmit,
    createdAt: new Date().toISOString(),
    conversationId: pair.conversationId,
    sessionId: pair.sessionId,
    turnId: formatTurnId(randomUUID()),
    payload: { input: "test concurrency" },
  };
}

async function openEvents(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    next: async () => {
      while (true) {
        const boundary = pending.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const fields = Object.fromEntries(raw.split("\n").map((line) => line.split(/: (.*)/s).slice(0, 2)));
          return { event: fields.event, data: JSON.parse(fields.data) };
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("Event stream closed before expected frame");
        pending += decoder.decode(value, { stream: true });
      }
    },
    close: async () => {
      clearTimeout(timeout);
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}
