import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableRecordTypes,
  formatCommandId,
  formatConversationId,
  formatRecordId,
  formatSessionId,
} from "@turnturn/protocol";
import { MemoryDurableSink } from "../dist/testing.js";

const uuid = (n) => `018f1f4e-8d5f-7abc-8123-923456789${String(n).padStart(3, "0")}`;

function draft(payload) {
  return {
    schemaVersion: 1,
    recordId: formatRecordId(uuid(1)),
    commandId: formatCommandId(uuid(2)),
    type: DurableRecordTypes.ConversationCreated,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: formatConversationId(uuid(3)),
    sessionId: formatSessionId(uuid(4)),
    payload,
  };
}

test("memory durable sink assigns sequence and keeps strict JSON semantics", async () => {
  const sink = new MemoryDurableSink();
  const record = await sink.append(draft({ title: "Demo" }));

  assert.equal(record.sequence, 1);
  assert.deepEqual(sink.records(), [record]);
});

test("memory durable sink rejects non-serializable drafts before storing", async () => {
  class RuntimeValue {}
  const invalidPayloads = [{ value: new Date() }, { value: new RuntimeValue() }, { value: undefined }];

  for (const payload of invalidPayloads) {
    const sink = new MemoryDurableSink();
    await assert.rejects(() => sink.append(draft(payload)), TypeError);
    assert.deepEqual(sink.records(), []);
  }
});
