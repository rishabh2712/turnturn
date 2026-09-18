import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatCompletionsHeaders,
  buildChatCompletionsRequest,
  buildChatCompletionsRequestBody,
} from "../../../dist/providers/openai-chat-completions/request.js";
import { workspaceToolDefinitions } from "../../../dist/workspace-tools.js";

test("chat completions request body maps model, streaming, history, and max tokens", () => {
  assert.deepEqual(
    buildChatCompletionsRequestBody({ model: "qwen", maxTokens: 50 }, providerRequest([user(1, "hello")])),
    {
      model: "qwen",
      stream: true,
      max_tokens: 50,
      messages: [{ role: "user", content: "hello" }],
    },
  );
});

test("chat completions headers include auth for LiteLLM and omit it for keyless Ollama", () => {
  assert.deepEqual(buildChatCompletionsHeaders({ apiKey: "sk-test", headers: { "X-Test": "yes" } }), {
    Authorization: "Bearer sk-test",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Test": "yes",
  });
  assert.deepEqual(buildChatCompletionsHeaders({}), {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
});

test("chat completions request targets the OpenAI-compatible route", () => {
  const request = buildChatCompletionsRequest(
    { baseUrl: "http://127.0.0.1:11434", model: "qwen" },
    providerRequest([]),
  );

  assert.equal(request.url.href, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(request.init.method, "POST");
  assert.equal(JSON.parse(request.init.body).model, "qwen");
});

test("wire evidence is the exact body serialized for fetch and excludes headers", () => {
  const request = buildChatCompletionsRequest(
    {
      baseUrl: "https://gateway.example",
      apiKey: "secret-key",
      headers: { "X-Secret": "secret-header" },
      model: "qwen",
    },
    providerRequest([user(1, "hello")]),
  );

  assert.deepEqual(request.wire, {
    method: "POST",
    route: "/v1/chat/completions",
    body: JSON.parse(request.init.body),
  });
  assert.equal(JSON.stringify(request.wire).includes("secret-key"), false);
  assert.equal(JSON.stringify(request.wire).includes("secret-header"), false);
});

test("chat completions request serializes all workspace tools as OpenAI function tools", () => {
  const body = buildChatCompletionsRequestBody(
    { model: "qwen" },
    { ...providerRequest([]), tools: workspaceToolDefinitions },
  );

  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    ["read", "write", "edit", "glob", "grep", "shell"],
  );
  for (const tool of body.tools) {
    assert.equal(tool.type, "function");
    assert.notEqual(tool.function.description.trim(), "");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(tool.function.parameters.$schema, undefined);
  }
});

function providerRequest(items) {
  return {
    conversationId: "conv_018f1f4e-8d5f-7abc-8123-000000000001",
    sessionId: "sess_018f1f4e-8d5f-7abc-8123-000000000002",
    turnId: "turn_018f1f4e-8d5f-7abc-8123-000000000003",
    stepId: "step_018f1f4e-8d5f-7abc-8123-000000000004",
    history: { items, issues: [], lastSequence: 0 },
    tools: [],
    signal: new AbortController().signal,
  };
}

function user(sequence, content) {
  return { type: "user.input", recordId: `rec_${sequence}`, sequence, turnId: "turn_1", content };
}
