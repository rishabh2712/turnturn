import { type ApprovalRequestItem, type ChatTransport, ConversationStore } from "@turnturn/chat-client";
import {
  ApprovalDecisions,
  formatApprovalId,
  formatConversationId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
} from "@turnturn/protocol";
import { expect, test, vi } from "vitest";
import { resolveApproval, sendTurn } from "../src/client-actions";

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

test("approval resolution sends the complete pending scope and selected decision", async () => {
  const approval = {
    sessionId,
    turnId: formatTurnId("33333333-3333-4333-8333-333333333333"),
    toolCallId: formatToolCallId("44444444-4444-4444-8444-444444444444"),
    approvalId: formatApprovalId("55555555-5555-4555-8555-555555555555"),
    stepId: formatStepId("66666666-6666-4666-8666-666666666666"),
  } as ApprovalRequestItem;
  const transport = { submitCommand: vi.fn(async () => ({ kind: "accepted" as const })) } as unknown as ChatTransport;

  expect(await resolveApproval(transport, conversationId, approval, ApprovalDecisions.Deny)).toBe("accepted");
  expect(transport.submitCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "approval.resolve",
      conversationId,
      sessionId,
      turnId: approval.turnId,
      toolCallId: approval.toolCallId,
      approvalId: approval.approvalId,
      payload: { decision: ApprovalDecisions.Deny },
    }),
  );
});

test("a late approval rejection is a cancelled action, not an unexplained command error", async () => {
  const approval = {
    sessionId,
    turnId: formatTurnId("33333333-3333-4333-8333-333333333333"),
    toolCallId: formatToolCallId("44444444-4444-4444-8444-444444444444"),
    approvalId: formatApprovalId("55555555-5555-4555-8555-555555555555"),
  } as ApprovalRequestItem;
  const transport = {
    submitCommand: vi.fn(async () => ({
      kind: "rejected" as const,
      code: "APPROVAL_NOT_PENDING",
      message: "Approval is not pending",
    })),
  } as unknown as ChatTransport;
  expect(await resolveApproval(transport, conversationId, approval, ApprovalDecisions.Allow)).toBe("cancelled");
});
