import assert from "node:assert/strict";
import test from "node:test";
import { parseAnthropicMessagesEvents } from "../../../dist/providers/anthropic-messages/adapter.js";
import { classifyAnthropicHttpFailure } from "../../../dist/providers/anthropic-messages/http.js";

test("Anthropic parser maps text, usage, and completion", async () => {
  const events = await collect([
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 7, output_tokens: 0 } },
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    frame("message_stop", { type: "message_stop" }),
  ]);

  assert.deepEqual(events, [
    { type: "usage", usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } },
    { type: "text-delta", text: "Hello" },
    { type: "usage", usage: { outputTokens: 2, totalTokens: 2 } },
    { type: "completed", reason: "complete", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } },
  ]);
});

test("Anthropic parser assembles a tool call before tool-use completion", async () => {
  const events = await collect([
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_2", usage: { input_tokens: 9, output_tokens: 0 } },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"' },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'README.md"}' },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }),
    frame("message_stop", { type: "message_stop" }),
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "usage",
      "tool-call-start",
      "tool-call-arguments-delta",
      "tool-call-arguments-delta",
      "tool-call-complete",
      "usage",
      "completed",
    ],
  );
  assert.deepEqual(events[4].call, { callId: "toolu_1", name: "read", input: { path: "README.md" } });
  assert.equal(events.at(-1).reason, "tool-use");
});

test("Anthropic parser rejects truncated tool JSON and contradictory stop reasons", async () => {
  const truncated = await collect([
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ]);
  assert.equal(truncated.at(-1).type, "failed");
  assert.equal(truncated.at(-1).error.kind, "protocol");

  const contradictory = await collect([
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  ]);
  assert.equal(contradictory.at(-1).type, "failed");
  assert.match(contradictory.at(-1).error.message, /with tool calls/);
});

test("Anthropic HTTP failures classify 400 and 429 deliberately", async () => {
  assert.deepEqual(await classifyAnthropicHttpFailure(new Response("bad request", { status: 400 })), {
    kind: "request-rejected",
    message: "bad request",
    retryable: false,
    status: 400,
  });
  assert.deepEqual(await classifyAnthropicHttpFailure(new Response("rate limited", { status: 429 })), {
    kind: "transport",
    message: "rate limited",
    retryable: true,
    status: 429,
  });
});

async function collect(frames) {
  const chunks = (async function* () {
    for (const value of frames) yield new TextEncoder().encode(value);
  })();
  const events = [];
  for await (const event of parseAnthropicMessagesEvents(chunks)) events.push(event);
  return events;
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
