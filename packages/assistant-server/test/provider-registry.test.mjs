import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicMessagesAdapter, OpenAIChatCompletionsAdapter } from "@turnturn/assistant-core";
import { createProviderConnection, ProviderRegistry } from "../dist/provider-registry.js";

test("a LiteLLM-style connection routing a Claude-named model still speaks openai-chat-completions", () => {
  const connection = createProviderConnection({
    id: "litellm",
    label: "LiteLLM Gateway",
    locality: "remote",
    wire: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:4000",
    apiKey: "litellm-secret",
  });
  const adapter = connection.createAdapter("bedrock-claude-5-sonnet");
  assert.ok(adapter instanceof OpenAIChatCompletionsAdapter);
  assert.ok(!(adapter instanceof AnthropicMessagesAdapter));
});

test("model brand never selects the adapter even when the wire is anthropic-messages", () => {
  const connection = createProviderConnection({
    id: "anthropic",
    label: "Anthropic",
    locality: "remote",
    wire: "anthropic-messages",
    apiKey: "anthropic-secret",
  });
  const adapter = connection.createAdapter("some-gpt-shaped-name");
  assert.ok(adapter instanceof AnthropicMessagesAdapter);
});

test("registry rejects a duplicate or invalid connection id", () => {
  const valid = createProviderConnection({ id: "ollama", label: "Ollama", locality: "local", wire: "ollama" });
  assert.throws(() => new ProviderRegistry([valid, valid]), /Duplicate provider connection id/);
  assert.throws(
    () => createProviderConnection({ id: "bad__id", label: "x", locality: "local", wire: "ollama" }),
    /must not contain "__"/,
  );
});

test("require surfaces a stable not-found error for an unconfigured connection", () => {
  const registry = new ProviderRegistry([]);
  assert.throws(() => registry.require("missing"), /PROVIDER_CONNECTION_NOT_FOUND/);
});
