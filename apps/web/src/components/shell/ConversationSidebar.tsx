import type { ConversationSummary } from "@turnturn/chat-client";
import type { ConversationId } from "@turnturn/protocol";
import { useEffect, useRef, useState } from "react";
import "./conversation-sidebar.css";

export interface ConversationSidebarProps {
  readonly workspaceName: string;
  readonly conversations: readonly ConversationSummary[];
  readonly archivedConversations: readonly ConversationSummary[];
  readonly selectedConversationId?: ConversationId;
  readonly onCreate: () => void | Promise<void>;
  readonly onSelect: (conversationId: ConversationId) => void;
  readonly onRename: (conversationId: ConversationId, title: string) => void | Promise<void>;
  readonly onArchive: (conversationId: ConversationId, archived: boolean) => void | Promise<void>;
}

export function ConversationSidebar(props: ConversationSidebarProps) {
  const [editingId, setEditingId] = useState<ConversationId | undefined>();
  const [draftTitle, setDraftTitle] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const ordered = sortByActivity(props.conversations);
  const archived = sortByActivity(props.archivedConversations);

  useEffect(() => {
    if (editingId !== undefined) renameInput.current?.focus();
  }, [editingId]);

  function beginRename(conversation: ConversationSummary) {
    setEditingId(conversation.conversationId);
    setDraftTitle(conversation.title ?? "");
  }

  function finishRename(conversationId: ConversationId) {
    const title = draftTitle.trim();
    setEditingId(undefined);
    if (title.length > 0) void props.onRename(conversationId, title);
  }

  function renderRow(conversation: ConversationSummary, isArchived: boolean) {
    const selected = conversation.conversationId === props.selectedConversationId;
    const title = conversation.title?.trim() || "New conversation";
    return (
      <li className={`tt-conversation-row${selected ? " is-selected" : ""}`} key={conversation.conversationId}>
        {editingId === conversation.conversationId ? (
          <input
            aria-label={`Rename ${title}`}
            className="tt-conversation-rename"
            ref={renameInput}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => finishRename(conversation.conversationId)}
            onKeyDown={(event) => {
              if (event.key === "Enter") finishRename(conversation.conversationId);
              if (event.key === "Escape") setEditingId(undefined);
            }}
          />
        ) : (
          <button
            aria-current={selected ? "page" : undefined}
            className="tt-conversation-select"
            onClick={() => props.onSelect(conversation.conversationId)}
            title={title}
            type="button"
          >
            <span aria-hidden="true" className="tt-conversation-mark" />
            <span className="tt-conversation-title">{title}</span>
          </button>
        )}
        {!isArchived && editingId !== conversation.conversationId ? (
          <button
            aria-label={`Rename ${title}`}
            className="tt-conversation-action"
            onClick={() => beginRename(conversation)}
            title="Rename"
            type="button"
          >
            ✎
          </button>
        ) : null}
        <button
          aria-label={`${isArchived ? "Unarchive" : "Archive"} ${title}`}
          className="tt-conversation-action"
          onClick={() => void props.onArchive(conversation.conversationId, !isArchived)}
          title={isArchived ? "Unarchive" : "Archive"}
          type="button"
        >
          {isArchived ? "↩" : "▣"}
        </button>
      </li>
    );
  }

  return (
    <aside aria-label="Conversations" className="tt-sidebar">
      <div className="tt-sidebar-top">
        <div className="tt-sidebar-brand">
          <span aria-hidden="true" className="tt-sidebar-brand-mark">
            ✦
          </span>
          <span>Turnturn</span>
        </div>
        <button className="tt-new-conversation" onClick={() => void props.onCreate()} type="button">
          <span aria-hidden="true">＋</span>
          <span>New conversation</span>
        </button>
      </div>

      <nav aria-label={`${props.workspaceName} conversations`} className="tt-sidebar-navigation">
        <h2 className="tt-sidebar-workspace" title={props.workspaceName}>
          {props.workspaceName}
        </h2>
        {ordered.length === 0 ? <p className="tt-sidebar-empty">Your conversations will appear here.</p> : null}
        <ul className="tt-conversation-list">{ordered.map((conversation) => renderRow(conversation, false))}</ul>
        {archived.length > 0 ? (
          <details className="tt-archived-section">
            <summary>
              Archived <span>{archived.length}</span>
            </summary>
            <ul className="tt-conversation-list">{archived.map((conversation) => renderRow(conversation, true))}</ul>
          </details>
        ) : null}
      </nav>
    </aside>
  );
}

function sortByActivity(conversations: readonly ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
