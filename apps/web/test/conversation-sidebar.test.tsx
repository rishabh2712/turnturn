// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatTransport, ConversationSummary } from "@turnturn/chat-client";
import { type ConversationId, formatConversationId } from "@turnturn/protocol";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ConversationSidebar } from "../src/components/shell/ConversationSidebar";

afterEach(cleanup);

const firstId = formatConversationId("11111111-1111-4111-8111-111111111111");
const secondId = formatConversationId("22222222-2222-4222-8222-222222222222");
const thirdId = formatConversationId("33333333-3333-4333-8333-333333333333");

function conversation(conversationId: ConversationId, title: string, lastActivityAt: string): ConversationSummary {
  return {
    conversationId,
    workspaceKey: "workspace",
    title,
    titleSource: "manual",
    createdAt: "2026-09-14T00:00:00.000Z",
    lastActivityAt,
    archived: false,
    sessionCount: 1,
  };
}

function setup() {
  const initial = [
    conversation(firstId, "Older conversation", "2026-09-14T01:00:00.000Z"),
    conversation(secondId, "Recent conversation", "2026-09-14T02:00:00.000Z"),
  ];
  const created = conversation(thirdId, "New conversation", "2026-09-14T03:00:00.000Z");
  const transport = {
    createConversation: vi.fn(async () => created),
    patchConversation: vi.fn(async (id: ConversationId, patch: { title?: string; archived?: boolean }) => ({
      ...[...initial, created].find((entry) => entry.conversationId === id),
      ...patch,
    })),
  } as unknown as ChatTransport;

  function Harness() {
    const [conversations, setConversations] = useState(initial);
    const [selected, setSelected] = useState<ConversationId | undefined>(firstId);
    const active = conversations.filter((entry) => !entry.archived);
    const archived = conversations.filter((entry) => entry.archived);
    return (
      <ConversationSidebar
        workspaceName="turnturn"
        conversations={active}
        archivedConversations={archived}
        selectedConversationId={selected}
        onCreate={async () => {
          const next = await transport.createConversation({ workspaceKey: "workspace" });
          setConversations((current) => [...current, next]);
          setSelected(next.conversationId);
        }}
        onSelect={setSelected}
        onRename={async (id, title) => {
          await transport.patchConversation(id, { title });
          setConversations((current) =>
            current.map((entry) => (entry.conversationId === id ? { ...entry, title } : entry)),
          );
        }}
        onArchive={async (id, isArchived) => {
          await transport.patchConversation(id, { archived: isArchived });
          setConversations((current) =>
            current.map((entry) => (entry.conversationId === id ? { ...entry, archived: isArchived } : entry)),
          );
        }}
      />
    );
  }

  render(<Harness />);
  return transport;
}

test("sidebar orders conversations by recent activity and selects one", () => {
  setup();
  const nav = screen.getByRole("navigation", { name: "turnturn conversations" });
  const choices = [...nav.querySelectorAll<HTMLButtonElement>(".tt-conversation-select")];
  expect(choices.map((button) => button.textContent?.trim())).toEqual(["Recent conversation", "Older conversation"]);
  fireEvent.click(screen.getByRole("button", { name: "Recent conversation" }));
  expect(screen.getByRole("button", { name: "Recent conversation" }).getAttribute("aria-current")).toBe("page");
});

test("new conversation delegates creation to the transport-backed action", async () => {
  const transport = setup();
  fireEvent.click(screen.getByRole("button", { name: "New conversation", exact: true }));
  await waitFor(() => expect(transport.createConversation).toHaveBeenCalledWith({ workspaceKey: "workspace" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("button", { name: "New conversation" })
        .some((button) => button.getAttribute("aria-current") === "page"),
    ).toBe(true),
  );
});

test("inline rename sends the edited title", async () => {
  const transport = setup();
  fireEvent.click(screen.getByRole("button", { name: "Rename Older conversation" }));
  const input = screen.getByRole("textbox", { name: "Rename Older conversation" });
  fireEvent.change(input, { target: { value: "Better title" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(transport.patchConversation).toHaveBeenCalledWith(firstId, { title: "Better title" }));
  expect(screen.getByRole("button", { name: "Better title" })).toBeTruthy();
});

test("archive moves a conversation into the archived section and allows restoration", async () => {
  const transport = setup();
  fireEvent.click(screen.getByRole("button", { name: "Archive Older conversation" }));
  await waitFor(() => expect(transport.patchConversation).toHaveBeenCalledWith(firstId, { archived: true }));
  const archived = screen.getByText("Archived").closest("details");
  if (archived === null) throw new Error("Archived section was not rendered");
  fireEvent.click(within(archived).getByText("Archived"));
  fireEvent.click(within(archived).getByRole("button", { name: "Unarchive Older conversation" }));
  await waitFor(() => expect(transport.patchConversation).toHaveBeenCalledWith(firstId, { archived: false }));
});
