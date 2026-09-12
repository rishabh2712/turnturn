import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIChatCompletionsAdapter,
  parseOpenAIChatCompletionsEvents,
} from "../../../dist/providers/openai-chat-completions/adapter.js";
import { classifyHttpFailure } from "../../../dist/providers/openai-chat-completions/http.js";

const encoder = new TextEncoder();

test("OpenAI chat-completions parser maps text, usage, and stop", async () => {
  const events = await collect(
    sse([
      {
        choices: [{ index: 0, delta: { role: "assistant", content: "Hey" } }],
      },
      {
        choices: [{ index: 0, delta: { content: " there!" } }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: 13, completion_tokens: 6, total_tokens: 19 },
      },
      "[DONE]",
    ]),
  );

  assert.deepEqual(events, [
    { type: "text-delta", text: "Hey" },
    { type: "text-delta", text: " there!" },
    { type: "usage", usage: { inputTokens: 13, outputTokens: 6, totalTokens: 19 } },
    { type: "completed", reason: "complete" },
  ]);
});

test("OpenAI chat-completions parser assembles tool calls before completion", async () => {
  const events = await collect(
    sse([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read" } }] },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"' } }] } }],
      },
      {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'README.md"}' } }] } }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  assert.deepEqual(events, [
    { type: "tool-call-start", callId: "call_1", name: "read" },
    { type: "tool-call-arguments-delta", callId: "call_1", text: '{"path":"' },
    { type: "tool-call-arguments-delta", callId: "call_1", text: 'README.md"}' },
    { type: "tool-call-complete", call: { callId: "call_1", name: "read", input: { path: "README.md" } } },
    { type: "completed", reason: "tool-use" },
  ]);
});

test("OpenAI chat-completions parser fails truncated tool JSON without completing the call", async () => {
  const events = await collect(
    sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start", "tool-call-arguments-delta", "failed"],
  );
  assert.equal(events.at(-1).error.kind, "protocol");
});

test("OpenAI chat-completions parser rejects stop with pending tool calls", async () => {
  const events = await collect(
    sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start", "tool-call-arguments-delta", "failed"],
  );
  assert.equal(events.at(-1).error.kind, "protocol");
  assert.match(events.at(-1).error.message, /pending tool calls/);
});

test("OpenAI chat-completions parser rejects tool_calls finish with no accumulated calls", async () => {
  const events = await collect(
    sse([
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  assert.deepEqual(events, [
    {
      type: "failed",
      error: {
        kind: "protocol",
        message: "Chat-completions finish_reason tool_calls arrived without tool calls",
        retryable: false,
      },
    },
  ]);
});

test("OpenAI chat-completions parser rejects completed tool calls without provider ids", async () => {
  const events = await collect(
    sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  assert.deepEqual(events, [
    {
      type: "failed",
      error: {
        kind: "protocol",
        message: "Tool call completed without a provider id",
        retryable: false,
      },
    },
  ]);
});

test("OpenAI chat-completions parser reports unknown finish reason as provider protocol failure", async () => {
  const events = await collect(
    sse([
      {
        choices: [{ index: 0, delta: {}, finish_reason: "new_gateway_reason" }],
      },
    ]),
  );

  assert.deepEqual(events, [
    {
      type: "failed",
      error: {
        kind: "protocol",
        message: "Unrecognised chat-completions finish_reason: new_gateway_reason",
        retryable: false,
      },
    },
  ]);
});

test("OpenAI chat-completions parser maps reasoning deltas from LiteLLM provider fields", async () => {
  const events = await collect(
    sse([
      {
        choices: [{ index: 0, delta: { reasoning_content: "thinking", content: "answer" } }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
  );

  assert.deepEqual(events, [
    { type: "text-delta", text: "answer" },
    { type: "reasoning-delta", text: "thinking" },
    { type: "completed", reason: "complete" },
  ]);
});

test("OpenAI chat-completions adapter reports fetch failures as retryable transport events", async () => {
  const adapter = new OpenAIChatCompletionsAdapter({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    model: "test-model",
  });

  const events = [];
  for await (const event of adapter.run(providerRequest())) events.push(event);

  assert.deepEqual(events, [
    {
      type: "failed",
      error: {
        kind: "transport",
        message: "fetch failed",
        retryable: true,
      },
    },
  ]);
});

test("OpenAI chat-completions adapter composes HTTP and stream parsing without a real socket", async () => {
  const adapter = new OpenAIChatCompletionsAdapter(
    {
      baseUrl: "http://unused.example",
      model: "test-model",
    },
    async () => ({
      kind: "stream",
      body: streamFromSse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"]),
    }),
  );

  const events = [];
  for await (const event of adapter.run(providerRequest())) events.push(event);

  assert.deepEqual(events, [{ type: "completed", reason: "complete" }]);
});

test("OpenAI chat-completions adapter classifies HTTP failures deliberately", async () => {
  assert.deepEqual(await classifyHttpFailure(new Response("bad request", { status: 400 })), {
    kind: "request-rejected",
    message: "bad request",
    retryable: false,
    status: 400,
  });
  assert.deepEqual(await classifyHttpFailure(new Response("rate limited", { status: 429 })), {
    kind: "transport",
    message: "rate limited",
    retryable: true,
    status: 429,
  });
});

async function collect(chunks) {
  const events = [];
  for await (const event of parseOpenAIChatCompletionsEvents(chunks)) events.push(event);
  return events;
}

function providerRequest() {
  return {
    conversationId: "conv_018f1f4e-8d5f-7abc-8123-000000000001",
    sessionId: "sess_018f1f4e-8d5f-7abc-8123-000000000002",
    turnId: "turn_018f1f4e-8d5f-7abc-8123-000000000003",
    stepId: "step_018f1f4e-8d5f-7abc-8123-000000000004",
    history: { items: [], issues: [], lastSequence: 0 },
    signal: new AbortController().signal,
  };
}

async function* sse(values) {
  for (const value of values) {
    yield encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
  }
}

function streamFromSse(values) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`));
      }
      controller.close();
    },
  });
}
