import assert from "node:assert/strict";
import test from "node:test";
import { providerHistoryToChatMessages } from "../../../dist/providers/openai-chat-completions/history.js";

test("chat history groups multiple tool calls from one step into one assistant message", () => {
  const messages = providerHistoryToChatMessages([
    user(1, "run both"),
    assistant(2, "I will inspect both files."),
    toolRequest(3, "tool_call_a", "step_1", "read", { path: "a.txt" }, "native_a", 0),
    toolRequest(4, "tool_call_b", "step_1", "read", { path: "b.txt" }, "native_b", 1),
    toolResult(5, "tool_call_a", { content: "A" }),
    toolResult(6, "tool_call_b", { content: "B" }),
    user(7, "continue"),
  ]);

  assert.deepEqual(messages, [
    { role: "user", content: "run both" },
    {
      role: "assistant",
      content: "I will inspect both files.",
      tool_calls: [
        { id: "native_a", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
        { id: "native_b", type: "function", function: { name: "read", arguments: '{"path":"b.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "tool_call_a", content: '{"content":"A"}' },
    { role: "tool", tool_call_id: "tool_call_b", content: '{"content":"B"}' },
    { role: "user", content: "continue" },
  ]);
});

test("chat history preserves a null tool output as a real output", () => {
  const messages = providerHistoryToChatMessages([
    toolRequest(1, "tool_call_null", "step_1", "read", { path: "empty.json" }, "native_null", 0),
    toolResult(2, "tool_call_null", null),
  ]);

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "native_null", type: "function", function: { name: "read", arguments: '{"path":"empty.json"}' } },
      ],
    },
    { role: "tool", tool_call_id: "tool_call_null", content: "null" },
  ]);
});

function user(sequence, content) {
  return { type: "user.input", recordId: `rec_${sequence}`, sequence, turnId: "turn_1", content };
}

function assistant(sequence, content) {
  return { type: "assistant.message", recordId: `rec_${sequence}`, sequence, turnId: "turn_1", content };
}

function toolRequest(sequence, toolCallId, stepId, name, input, providerToolCallId, providerOrder) {
  return {
    type: "tool.request",
    recordId: `rec_${sequence}`,
    sequence,
    turnId: "turn_1",
    stepId,
    toolCallId,
    name,
    input,
    providerOrder,
    requiresApproval: false,
    providerToolCallId,
  };
}

function toolResult(sequence, toolCallId, output) {
  return {
    type: "tool.result",
    recordId: `rec_${sequence}`,
    sequence,
    turnId: "turn_1",
    toolCallId,
    status: "completed",
    output,
    synthetic: false,
  };
}
