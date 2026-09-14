import { type ChatTransport, ConversationStore } from "@turnturn/chat-client";
import { formatConversationId, formatSessionId } from "@turnturn/protocol";
import { expect, test, vi } from "vitest";
import { sendTurn } from "../src/client-actions";

const conversationId = formatConversationId("11111111-1111-4111-8111-111111111111");
const sessionId = formatSessionId("22222222-2222-4222-8222-222222222222");

test("send activates a session, shows optimistic text, and submits a scoped turn", async () => {
  const store = new ConversationStore(conversationId);
  const transport = {
    activateConversation: vi.fn(async () => ({
      sessionId,
      ordinal: 1,
      provider: "ollama",
      model: "test",
      isNewSession: true,
    })),
    submitCommand: vi.fn(async () => ({ kind: "accepted" as const })),
  } as unknown as ChatTransport;

  await sendTurn(transport, store, conversationId, "  hello  ");

  expect(store.getSnapshot().view.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "user-message", text: "hello", source: "optimistic" })]),
  );
  expect(transport.submitCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "turn.submit",
      conversationId,
      sessionId,
      payload: { input: "hello" },
    }),
  );
});

test("a rejected send removes the optimistic user message", async () => {
  const store = new ConversationStore(conversationId);
  const transport = {
    activateConversation: vi.fn(async () => ({
      sessionId,
      ordinal: 1,
      provider: "ollama",
      model: "test",
      isNewSession: true,
    })),
    submitCommand: vi.fn(async () => ({ kind: "rejected" as const, code: "NO", message: "Not allowed" })),
  } as unknown as ChatTransport;

  await expect(sendTurn(transport, store, conversationId, "hello")).rejects.toThrow("NO: Not allowed");
  expect(store.getSnapshot().view.items.some((item) => item.kind === "user-message")).toBe(false);
});
