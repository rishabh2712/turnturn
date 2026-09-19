import assert from "node:assert/strict";
import test from "node:test";
import { providerHistoryToAnthropicMessages } from "../../../dist/providers/anthropic-messages/history.js";
import {
  buildAnthropicMessagesHeaders,
  buildAnthropicMessagesRequestBody,
} from "../../../dist/providers/anthropic-messages/request.js";
import { workspaceToolDefinitions } from "../../../dist/workspace-tools.js";

test("Anthropic request uses native headers, history, and tool schema", () => {
  assert.deepEqual(buildAnthropicMessagesHeaders({ apiKey: "test-key" }), {
    "x-api-key": "test-key",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  const body = buildAnthropicMessagesRequestBody(
    { model: "claude-test", maxTokens: 200 },
    { ...providerRequest([user(1, "hello")]), tools: workspaceToolDefinitions },
  );
  assert.equal(body.model, "claude-test");
  assert.equal(body.max_tokens, 200);
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    ["read", "write", "edit", "glob", "grep", "shell"],
  );
  assert.equal(body.tools[0].input_schema.type, "object");
});

test("Anthropic history groups multi-tool requests and results into valid messages", () => {
  const messages = providerHistoryToAnthropicMessages([
    user(1, "read both"),
    assistant(2, "I will inspect them."),
    toolRequest(3, "call_a", "native_a", "read", { path: "a.txt" }),
    toolRequest(4, "call_b", "native_b", "read", { path: "b.txt" }),
    toolResult(5, "call_a", { content: "A" }),
    toolResult(6, "call_b", null),
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "read both" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect them." },
        { type: "tool_use", id: "native_a", name: "read", input: { path: "a.txt" } },
        { type: "tool_use", id: "native_b", name: "read", input: { path: "b.txt" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "native_a", content: '{"content":"A"}' },
        { type: "tool_result", tool_use_id: "native_b", content: "null" },
      ],
    },
  ]);
});

function providerRequest(items) {
  return {
    conversationId: "conv_018f1f4e-8d5f-7abc-8123-000000000001",
    sessionId: "sess_018f1f4e-8d5f-7abc-8123-000000000002",
    turnId: "turn_018f1f4e-8d5f-7abc-8123-000000000003",
    stepId: "step_018f1f4e-8d5f-7abc-8123-000000000004",
    history: { items, issues: [], lastSequence: items.at(-1)?.sequence ?? 0 },
    tools: [],
    signal: new AbortController().signal,
  };
}
function user(sequence, content) {
  return { type: "user.input", recordId: `rec_${sequence}`, sequence, turnId: "turn_1", content };
}
function assistant(sequence, content) {
  return { type: "assistant.message", recordId: `rec_${sequence}`, sequence, turnId: "turn_1", content };
}
function toolRequest(sequence, toolCallId, providerToolCallId, name, input) {
  return {
    type: "tool.request",
    recordId: `rec_${sequence}`,
    sequence,
    turnId: "turn_1",
    stepId: "step_1",
    toolCallId,
    name,
    input,
    providerOrder: sequence,
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
