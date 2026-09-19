// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatTransport, ConversationSummary, LiveSubscriptionHandlers } from "@turnturn/chat-client";
import {
  formatConversationId,
  formatEventId,
  formatSessionId,
  formatStepId,
  LiveEventTypes,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { TransportProvider } from "../src/providers/TransportProvider";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const conversationId = formatConversationId("11111111-1111-4111-8111-111111111111");
const sessionId = formatSessionId("22222222-2222-4222-8222-222222222222");
const stepId = formatStepId("33333333-3333-4333-8333-333333333333");
const summary: ConversationSummary = {
  conversationId,
  workspaceKey: "ws",
  title: "First conversation",
  titleSource: "auto",
  createdAt: "2026-09-14T00:00:00Z",
  lastActivityAt: "2026-09-14T00:00:00Z",
  archived: false,
  sessionCount: 0,
};

test("the first browser conversation sends a turn and renders streamed assistant text without the debug harness", async () => {
  let created = false;
  let handlers: LiveSubscriptionHandlers | undefined;
  const transport = {
    getRuntime: vi.fn(async () => ({
      workspace: { key: "ws", path: "/workspace", name: "workspace" },
      provider: "ollama",
      model: "local-model",
      defaultModelProfileId: "local",
      models: [
        { id: "local", label: "Local model", provider: "ollama", model: "local-model" },
        { id: "anthropic", label: "Claude", provider: "anthropic-messages", model: "claude-test" },
      ],
      baseUrlHost: null,
      maxTokens: null,
      serverInstanceId: "server",
      storageVersion: 1,
      schemaVersion: 1,
      tools: [],
    })),
    listProviders: vi.fn(async () => ({
      connections: [
        {
          id: "ollama",
          label: "Ollama",
          locality: "local",
          wire: "ollama",
          status: "idle",
          stale: false,
          lastSuccessAt: null,
          error: null,
          models: [
            {
              id: "local",
              label: "Local model",
              model: "local-model",
              source: "configured",
              toolCompatibility: "supported",
              available: true,
            },
          ],
        },
        {
          id: "anthropic-messages",
          label: "Anthropic",
          locality: "remote",
          wire: "anthropic-messages",
          status: "idle",
          stale: false,
          lastSuccessAt: null,
          error: null,
          models: [
            {
              id: "anthropic",
              label: "Claude",
              model: "claude-test",
              source: "configured",
              toolCompatibility: "supported",
              available: true,
            },
          ],
        },
      ],
    })),
    refreshProviders: vi.fn(async () => ({ connections: [] })),
    listConversations: vi.fn(async ({ archived = false } = {}) => ({
      conversations: created && !archived ? [summary] : [],
      nextCursor: null,
    })),
    createConversation: vi.fn(async () => {
      created = true;
      return summary;
    }),
    getConversation: vi.fn(async () => ({ conversation: summary, sessions: [] })),
    activateConversation: vi.fn(async (_conversationId, params) => ({
      sessionId,
      ordinal: 1,
      provider: params?.modelProfileId === "anthropic" ? "anthropic-messages" : "ollama",
      model: params?.modelProfileId === "anthropic" ? "claude-test" : "local-model",
      modelProfileId: params?.modelProfileId ?? "local",
      isNewSession: true,
    })),
    submitCommand: vi.fn(async () => ({ kind: "accepted" as const })),
    subscribeEvents: vi.fn((_id, nextHandlers) => {
      handlers = nextHandlers;
      queueMicrotask(() => nextHandlers.onSnapshot({ conversationId, serverInstanceId: "server", sessions: [] }));
      return () => {
        handlers = undefined;
      };
    }),
  } as unknown as ChatTransport;

  render(
    <TransportProvider transport={transport}>
      <App />
    </TransportProvider>,
  );
  await screen.findByText("What would you like to work on?");
  expect(screen.queryByText("Protocol timeline")).toBeNull();
  expect(screen.queryByText("Initialize")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  await screen.findByRole("option", { name: /Claude/i });
  fireEvent.click(screen.getByRole("option", { name: /Claude/i }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello local model" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(transport.submitCommand).toHaveBeenCalledTimes(1));
  expect(transport.activateConversation).toHaveBeenCalledWith(conversationId, { modelProfileId: "anthropic" });
  await screen.findByText("Hello local model");
  await waitFor(() => expect(handlers).toBeDefined());

  const sent = vi.mocked(transport.submitCommand).mock.calls[0]?.[0];
  if (sent?.turnId === undefined || handlers === undefined) throw new Error("Turn or subscription missing");
  handlers.onEvent({
    schemaVersion: SCHEMA_VERSION,
    eventId: formatEventId("44444444-4444-4444-8444-444444444444"),
    type: LiveEventTypes.ContentDelta,
    createdAt: "2026-09-14T00:00:01Z",
    conversationId,
    sessionId,
    turnId: sent.turnId,
    stepId,
    payload: { text: "Hello back" },
  });
  await screen.findByText(/Hello back/);
});
