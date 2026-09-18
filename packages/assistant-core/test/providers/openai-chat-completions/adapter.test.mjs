import assert from "node:assert/strict";
import test from "node:test";
import { createSafeObservationPort } from "../../../dist/observability/context.js";
import {
  OpenAIChatCompletionsAdapter,
  parseOpenAIChatCompletionsEvents,
} from "../../../dist/providers/openai-chat-completions/adapter.js";
import {
  classifyHttpFailure,
  requestChatCompletionsStream,
} from "../../../dist/providers/openai-chat-completions/http.js";

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

test("stream observations preserve raw-frame to provider-event correspondence", async (context) => {
  const cases = [
    {
      name: "text and reasoning",
      values: [
        { choices: [{ index: 0, delta: { content: "answer", reasoning_content: "thinking" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ],
      timeline: ["raw", "text-delta", "reasoning-delta", "raw", "raw", "completed"],
    },
    {
      name: "interleaved tool calls",
      values: [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"' } },
                  { index: 1, id: "call_2", function: { name: "grep", arguments: '{"query":"' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, function: { arguments: 'needle"}' } },
                  { index: 0, function: { arguments: 'README.md"}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      timeline: [
        "raw",
        "tool-call-start",
        "tool-call-arguments-delta",
        "tool-call-start",
        "tool-call-arguments-delta",
        "raw",
        "tool-call-arguments-delta",
        "tool-call-arguments-delta",
        "raw",
        "tool-call-complete",
        "tool-call-complete",
        "completed",
      ],
    },
    {
      name: "usage after finish",
      values: [
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        "[DONE]",
      ],
      timeline: ["raw", "raw", "usage", "raw", "completed"],
    },
    {
      name: "unknown finish reason",
      values: [{ choices: [{ index: 0, delta: {}, finish_reason: "future_reason" }] }],
      timeline: ["raw", "failed"],
    },
    {
      name: "truncated tool arguments",
      values: [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      timeline: ["raw", "tool-call-start", "tool-call-arguments-delta", "raw", "failed"],
    },
    {
      name: "interrupted stream",
      values: [{ choices: [{ index: 0, delta: { content: "partial" } }] }],
      timeline: ["raw", "text-delta", "failed"],
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const observation = recordingStreamObservation();
      await collect(sse(scenario.values), observation);
      assert.deepEqual(
        observation.timeline.map((item) => item.type),
        scenario.timeline,
      );
      assert.deepEqual(
        observation.rawFrames.map((frame) => frame.data),
        scenario.values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))),
      );
    });
  }
});

test("disabled, enabled, and failing stream observation leave adapter output identical", async () => {
  const values = [
    { choices: [{ index: 0, delta: { content: "same" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ];
  const adapter = new OpenAIChatCompletionsAdapter(
    { baseUrl: "http://unused.example", model: "test-model" },
    async () => ({ kind: "stream", status: 200, body: streamFromSse(values) }),
  );
  const enabled = recordingStepObservation();
  const failing = failingSafeStepObservation();

  const disabledEvents = await collectAdapter(adapter);
  const enabledEvents = await collectAdapter(adapter, enabled.step);
  const failingEvents = await collectAdapter(adapter, failing.step);

  assert.deepEqual(enabledEvents, disabledEvents);
  assert.deepEqual(failingEvents, disabledEvents);
  assert.ok(enabled.attempts[0].rawFrames.length > 0);
  assert.ok(enabled.attempts[0].providerEvents.length > 0);
  assert.ok(failing.failures.some((failure) => failure.operation === "attempt.raw-response-frame"));
  assert.ok(failing.failures.some((failure) => failure.operation === "attempt.provider-event"));
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

test("transport exposes exact wire evidence immediately before fetch", async () => {
  const originalFetch = globalThis.fetch;
  const timeline = [];
  let fetchedBody;
  globalThis.fetch = async (_url, init) => {
    timeline.push("fetch");
    fetchedBody = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    let wire;
    await requestChatCompletionsStream({ baseUrl: "http://unused.example", model: "test-model" }, providerRequest(), {
      beforeFetch(value) {
        timeline.push("wire");
        wire = value;
      },
    });
    assert.deepEqual(timeline, ["wire", "fetch"]);
    assert.deepEqual(wire.body, fetchedBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI chat-completions adapter composes HTTP and stream parsing without a real socket", async () => {
  const observed = recordingStepObservation();
  const adapter = new OpenAIChatCompletionsAdapter(
    {
      baseUrl: "http://unused.example",
      model: "test-model",
    },
    async (_options, _request, hooks) => {
      hooks.beforeFetch({ method: "POST", route: "/v1/chat/completions", body: { model: "test-model" } });
      return {
        kind: "stream",
        status: 200,
        upstreamRequestId: "request-123",
        body: streamFromSse([
          { id: "chatcmpl-123", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      };
    },
  );

  const events = [];
  for await (const event of adapter.run(providerRequest(), observed.step)) events.push(event);

  assert.deepEqual(events, [{ type: "completed", reason: "complete" }]);
  assert.deepEqual(observed.attempts[0].wireRequests, [
    { method: "POST", route: "/v1/chat/completions", body: { model: "test-model" } },
  ]);
  assert.deepEqual(observed.attempts[0].metadata, [{ status: 200, upstreamRequestId: "request-123" }]);
  assert.equal(observed.attempts[0].terminal.type, "completed");
  assert.equal(observed.attempts[0].terminal.outcome.reason, "complete");
  assert.equal(observed.attempts[0].terminal.outcome.responseId, "chatcmpl-123");
  assert.equal(typeof observed.attempts[0].terminal.outcome.durationMs, "number");
});

test("adapter records normalized failure and cancellation as attempt terminals", async () => {
  const failed = recordingStepObservation();
  const failedAdapter = new OpenAIChatCompletionsAdapter(
    { baseUrl: "http://unused.example", model: "test-model" },
    async () => ({
      kind: "failed",
      event: { type: "failed", error: { kind: "transport", message: "unavailable", retryable: true, status: 503 } },
      status: 503,
      upstreamRequestId: "failed-request",
    }),
  );
  const failedEvents = [];
  for await (const event of failedAdapter.run(providerRequest(), failed.step)) failedEvents.push(event);
  assert.equal(failed.attempts[0].terminal.type, "failed");
  assert.deepEqual(failed.attempts[0].metadata, [{ status: 503, upstreamRequestId: "failed-request" }]);
  assert.deepEqual(failed.attempts[0].providerEvents, failedEvents);

  const cancelled = recordingStepObservation();
  const controller = new AbortController();
  controller.abort("stop");
  const cancelledAdapter = new OpenAIChatCompletionsAdapter(
    { baseUrl: "http://unused.example", model: "test-model" },
    async () => ({
      kind: "failed",
      event: { type: "failed", error: { kind: "transport", message: "aborted", retryable: true } },
    }),
  );
  for await (const _event of cancelledAdapter.run(
    { ...providerRequest(), signal: controller.signal },
    cancelled.step,
  )) {
    // Drain the provider so the terminal observation is recorded.
  }
  assert.equal(cancelled.attempts[0].terminal.type, "cancelled");
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

async function collect(chunks, observation) {
  const events = [];
  for await (const event of parseOpenAIChatCompletionsEvents(
    chunks,
    observation === undefined
      ? {}
      : {
          onRawFrame: (frame) => observation.rawResponseFrame(frame),
          onProviderEvent: (event) => observation.providerEvent(event),
        },
  ))
    events.push(event);
  return events;
}

async function collectAdapter(adapter, step) {
  const events = [];
  for await (const event of adapter.run(providerRequest(), step)) events.push(event);
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

function recordingStepObservation() {
  const attempts = [];
  return {
    attempts,
    step: {
      modelContext() {},
      startProviderAttempt(start) {
        const attempt = {
          start,
          wireRequests: [],
          metadata: [],
          rawFrames: [],
          providerEvents: [],
          issues: [],
          terminal: undefined,
        };
        attempts.push(attempt);
        return {
          wireRequest(value) {
            attempt.wireRequests.push(value);
          },
          responseMetadata(value) {
            attempt.metadata.push(value);
          },
          rawResponseFrame(frame) {
            attempt.rawFrames.push(frame);
          },
          providerEvent(event) {
            attempt.providerEvents.push(event);
          },
          complete(outcome) {
            attempt.terminal = { type: "completed", outcome };
          },
          fail(error) {
            attempt.terminal = { type: "failed", error };
          },
          cancel(reason) {
            attempt.terminal = { type: "cancelled", reason };
          },
          issue(value) {
            attempt.issues.push(value);
          },
        };
      },
      complete() {},
      fail() {},
      cancel() {},
    },
  };
}

function recordingStreamObservation() {
  const rawFrames = [];
  const providerEvents = [];
  const timeline = [];
  return {
    rawFrames,
    providerEvents,
    timeline,
    rawResponseFrame(frame) {
      rawFrames.push(frame);
      timeline.push({ type: "raw", value: frame });
    },
    providerEvent(event) {
      providerEvents.push(event);
      timeline.push({ type: event.type, value: event });
    },
  };
}

function failingSafeStepObservation() {
  const failures = [];
  const fail = () => {
    throw new Error("trace unavailable");
  };
  const attempt = {
    wireRequest: fail,
    responseMetadata: fail,
    rawResponseFrame: fail,
    providerEvent: fail,
    complete: fail,
    fail,
    cancel: fail,
    issue: fail,
  };
  const step = {
    modelContext: fail,
    startProviderAttempt: () => attempt,
    complete: fail,
    fail,
    cancel: fail,
  };
  const safe = createSafeObservationPort({
    startTurn: () => ({
      startStep: () => step,
      observeTool: fail,
      observeApproval: fail,
      complete: fail,
      fail,
      cancel: fail,
    }),
    degraded: (failure) => failures.push(failure),
  });
  const turn = safe.startTurn(providerRequest());
  return { failures, step: turn.startStep(providerRequest()) };
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
