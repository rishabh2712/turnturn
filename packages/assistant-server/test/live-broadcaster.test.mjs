import assert from "node:assert/strict";
import test from "node:test";
import { LiveEventTypes, SCHEMA_VERSION } from "@turnturn/protocol";
import { RuntimeClock, RuntimeIds } from "../dist/ids.js";
import { LiveBroadcaster } from "../dist/live-broadcaster.js";

test("conversation subscribers receive only their own live events and session cursors", () => {
  const ids = new RuntimeIds();
  const clock = new RuntimeClock();
  const broadcaster = new LiveBroadcaster({ ids, clock, currentSequence: () => 99 });
  const a = sink();
  const b = sink();
  const conversationA = ids.conversationId();
  const conversationB = ids.conversationId();
  const sessionA = ids.sessionId();
  const sessionB = ids.sessionId();
  broadcaster.subscribe(a, {
    conversationId: conversationA,
    serverInstanceId: "srv_test",
    sessions: [{ sessionId: sessionA, lastSequence: 12 }],
  });
  broadcaster.subscribe(b, {
    conversationId: conversationB,
    serverInstanceId: "srv_test",
    sessions: [{ sessionId: sessionB, lastSequence: 7 }],
  });
  assert.match(a.frames[0], /"lastSequence":12/);
  assert.match(b.frames[0], /"lastSequence":7/);
  assert.doesNotMatch(a.frames[0], /^id:/m);
  broadcaster.publish({
    schemaVersion: SCHEMA_VERSION,
    eventId: ids.eventId(),
    type: LiveEventTypes.ContentDelta,
    createdAt: clock.now(),
    conversationId: conversationB,
    sessionId: sessionB,
    payload: { text: "B only" },
  });
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 2);
  assert.match(b.frames[1], /B only/);
});

function sink() {
  return {
    frames: [],
    write(frame) {
      this.frames.push(frame);
      return true;
    },
    once() {
      return this;
    },
    end() {},
  };
}
