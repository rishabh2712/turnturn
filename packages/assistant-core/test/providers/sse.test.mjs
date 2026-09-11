import assert from "node:assert/strict";
import test from "node:test";
import { collectSseEvents } from "../../dist/providers/sse.js";

const encoder = new TextEncoder();

test("SSE parser handles complete chunks, comments, CRLF, ids, retry, and multiline data", async () => {
  const events = await collectSseEvents(
    chunks([
      'event: message_start\r\nid: abc\r\nretry: 1000\r\ndata: {"type":"start"}\r\n\r\n',
      ": keep-alive\n\n",
      "data: first line\ndata: second line\n\n",
    ]),
  );

  assert.deepEqual(events, [
    { event: "message_start", id: "abc", retry: 1000, data: '{"type":"start"}' },
    { data: "first line\nsecond line" },
  ]);
});

test("SSE parser buffers split frames", async () => {
  const events = await collectSseEvents(chunks(["event: content_", 'block_delta\ndata: {"delta":"hel', 'lo"}\n\n']));

  assert.deepEqual(events, [{ event: "content_block_delta", data: '{"delta":"hello"}' }]);
});

test("SSE parser survives one-byte chunking", async () => {
  const events = await collectSseEvents(byteChunks("data: one\n\ndata: two\n\n"));

  assert.deepEqual(events, [{ data: "one" }, { data: "two" }]);
});

test("SSE parser keeps split UTF-8 multibyte characters intact", async () => {
  const encoded = encoder.encode("data: snowman ☃ and devanagari क्ष\n\n");
  const events = await collectSseEvents(asyncChunks(encoded.slice(0, 15), encoded.slice(15, 24), encoded.slice(24)));

  assert.deepEqual(events, [{ data: "snowman ☃ and devanagari क्ष" }]);
});

test("SSE parser flushes a final unterminated event at stream end", async () => {
  const events = await collectSseEvents(chunks(["event: done\ndata: [DONE]"]));

  assert.deepEqual(events, [{ event: "done", data: "[DONE]" }]);
});

async function* chunks(values) {
  for (const value of values) yield encoder.encode(value);
}

async function* byteChunks(value) {
  const encoded = encoder.encode(value);
  for (const byte of encoded) yield Uint8Array.of(byte);
}

async function* asyncChunks(...values) {
  for (const value of values) yield value;
}
