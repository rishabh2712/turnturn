import assert from "node:assert/strict";
import test from "node:test";
import {
  createTranslationState,
  translateFrame,
  translateStreamEnd,
} from "../../../dist/providers/openai-chat-completions/translate.js";

test("translator preserves usage that arrives after finish and before DONE", () => {
  const state = createTranslationState();

  assert.deepEqual(translateFrame(chat({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), state), []);
  assert.deepEqual(translateFrame(chat({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }), state), [
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
  ]);
  assert.deepEqual(translateFrame(done(), state), [{ type: "completed", reason: "complete" }]);
});

test("translator rejects tool_calls finish with no accumulated calls", () => {
  const state = createTranslationState();

  assert.deepEqual(translateFrame(chat({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }), state), [
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

test("translator rejects stop with pending tool calls", () => {
  const state = createTranslationState();

  assert.deepEqual(
    translateFrame(
      chat({
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
            finish_reason: "stop",
          },
        ],
      }),
      state,
    ).map((event) => event.type),
    ["tool-call-start", "tool-call-arguments-delta", "failed"],
  );
});

test("translator treats DONE without finish_reason as interrupted instead of guessing complete", () => {
  const state = createTranslationState();

  assert.deepEqual(translateFrame(done(), state), [
    {
      type: "failed",
      error: { kind: "interrupted", message: "SSE stream ended before completion", retryable: true },
    },
  ]);
});

test("translator treats stream end without DONE as interrupted when no finish reason arrived", () => {
  const state = createTranslationState();

  assert.deepEqual(translateStreamEnd(state), [
    {
      type: "failed",
      error: { kind: "interrupted", message: "SSE stream ended before completion", retryable: true },
    },
  ]);
});

test("translator suppresses empty usage objects", () => {
  const state = createTranslationState();

  assert.deepEqual(translateFrame(chat({ choices: [], usage: {} }), state), []);
});

test("translator rejects content deltas after finish_reason", () => {
  const state = createTranslationState();

  assert.deepEqual(translateFrame(chat({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), state), []);
  assert.deepEqual(translateFrame(chat({ choices: [{ index: 0, delta: { content: "late" } }] }), state), [
    {
      type: "failed",
      error: {
        kind: "protocol",
        message: "Chat-completions delta arrived after finish_reason",
        retryable: false,
      },
    },
  ]);
});

function chat(value) {
  return { kind: "chat-frame", value };
}

function done() {
  return { kind: "done" };
}
