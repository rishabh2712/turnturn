import {
  type ChatTransport,
  ConversationStore,
  type ConversationViewItem,
  resumeConversation,
} from "@turnturn/chat-client";
import type { ConversationId, TurnId } from "@turnturn/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sendTurn } from "./client-actions";
import { ConversationSidebar } from "./components/shell/ConversationSidebar";
import { ConversationListProvider, useConversationList } from "./providers/ConversationListProvider";
import { RuntimeProvider, useRuntime } from "./providers/RuntimeProvider";
import { useChatTransport } from "./providers/TransportProvider";
import "./styles.css";

export function App() {
  return (
    <RuntimeProvider>
      <ConversationListProvider>
        <AppShell />
      </ConversationListProvider>
    </RuntimeProvider>
  );
}

function AppShell() {
  const runtime = useRuntime();
  const list = useConversationList();
  const transport = useChatTransport();
  const stores = useRef(new Map<ConversationId, ConversationStore>());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function storeFor(id: ConversationId): ConversationStore {
    let store = stores.current.get(id);
    if (store === undefined) {
      store = new ConversationStore(id);
      stores.current.set(id, store);
    }
    return store;
  }

  async function beginConversation() {
    if (busy || draft.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = await list.create();
      await sendTurn(transport, storeFor(id), id, draft);
      setDraft("");
      await list.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const selected = [...list.conversations, ...list.archivedConversations].find(
    (conversation) => conversation.conversationId === list.selectedId,
  );

  return (
    <div className="tt-app-shell">
      <ConversationSidebar
        workspaceName={runtime.status === "ready" ? runtime.runtime.workspace.name : "Workspace"}
        conversations={list.conversations}
        archivedConversations={list.archivedConversations}
        selectedConversationId={list.selectedId}
        onCreate={() => {
          void list.create().catch((cause: unknown) => setError(messageOf(cause)));
        }}
        onSelect={list.select}
        onRename={(id, title) => list.rename(id, title).catch((cause: unknown) => setError(messageOf(cause)))}
        onArchive={(id, archived) => list.archive(id, archived).catch((cause: unknown) => setError(messageOf(cause)))}
      />
      <main className="tt-main">
        {runtime.status === "error" ? <p role="alert">Could not load workspace: {runtime.message}</p> : null}
        {list.status === "error" ? <p role="alert">Could not load conversations: {list.error}</p> : null}
        {error !== undefined ? (
          <p className="tt-notice" role="alert">
            {error}
          </p>
        ) : null}
        {selected !== undefined ? (
          <ConversationPane
            key={selected.conversationId}
            conversationId={selected.conversationId}
            title={selected.title ?? "New conversation"}
            archived={selected.archived}
            store={storeFor(selected.conversationId)}
            transport={transport}
            workspaceName={runtime.status === "ready" ? runtime.runtime.workspace.name : "Workspace"}
            model={runtime.status === "ready" ? runtime.runtime.model : ""}
            onActivity={list.refresh}
          />
        ) : list.status === "loading" || runtime.status === "loading" ? (
          <div className="tt-centered-state">Opening workspace…</div>
        ) : (
          <div className="tt-first-run">
            <div className="tt-first-run-copy">
              <span className="tt-sparkle" aria-hidden="true">
                ✦
              </span>
              <h1>What would you like to work on?</h1>
              <p>{runtime.status === "ready" ? runtime.runtime.workspace.path : "Create a conversation to begin."}</p>
            </div>
            <Composer
              draft={draft}
              setDraft={setDraft}
              onSend={beginConversation}
              disabled={busy || runtime.status !== "ready"}
              busy={busy}
              footer={runtime.status === "ready" ? `${runtime.runtime.workspace.name} · ${runtime.runtime.model}` : ""}
            />
          </div>
        )}
      </main>
    </div>
  );
}

interface ConversationPaneProps {
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly archived: boolean;
  readonly store: ConversationStore;
  readonly transport: ChatTransport;
  readonly workspaceName: string;
  readonly model: string;
  readonly onActivity: () => Promise<void>;
}

function ConversationPane(props: ConversationPaneProps) {
  const { conversationId, store, transport } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [submittedTurnId, setSubmittedTurnId] = useState<TurnId | undefined>();

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void transport.getConversation(conversationId).then(
      (detail) => {
        if (!active) return;
        for (const session of detail.sessions) {
          store.registerSession(session.sessionId, session.ordinal, session.provider, session.model);
        }
        stop = resumeConversation(transport, store, conversationId).stop;
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(messageOf(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
      stop?.();
    };
  }, [transport, store, conversationId]);

  useEffect(() => {
    if (submittedTurnId === undefined) return;
    if (snapshot.view.items.some((item) => item.kind === "turn-status" && item.turnId === submittedTurnId)) {
      setSubmittedTurnId(undefined);
    }
  }, [snapshot.view.items, submittedTurnId]);

  async function submit() {
    if (busy || submittedTurnId !== undefined || snapshot.view.activeTurn !== undefined || draft.trim().length === 0)
      return;
    setBusy(true);
    setError(undefined);
    try {
      const turnId = await sendTurn(transport, store, conversationId, draft);
      setSubmittedTurnId(turnId);
      setDraft("");
      await props.onActivity();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const connected = snapshot.connection.status === "connected";
  const canSend = !loading && !props.archived && (connected || snapshot.connection.status === "connecting");
  const blocked = busy || submittedTurnId !== undefined || snapshot.view.activeTurn !== undefined || !canSend;

  return (
    <div className="tt-conversation">
      <header className="tt-header">
        <div className="tt-header-title">
          <h1>{props.title}</h1>
          <span className="tt-workspace-chip">{props.workspaceName}</span>
        </div>
        <div className="tt-header-meta">
          <span>{props.model}</span>
          <span className={`tt-connection ${connected ? "is-connected" : ""}`}>{snapshot.connection.status}</span>
        </div>
      </header>
      {snapshot.connection.status === "reconnecting" ? (
        <div className="tt-connection-banner">Reconnecting. The conversation remains readable.</div>
      ) : null}
      {error !== undefined ? (
        <p className="tt-notice" role="alert">
          {error}
        </p>
      ) : null}
      <div aria-live="polite" className="tt-transcript">
        {loading ? <p className="tt-muted">Loading conversation…</p> : null}
        {!loading && snapshot.view.items.length === 0 ? (
          <div className="tt-empty-conversation">
            <span className="tt-sparkle" aria-hidden="true">
              ✦
            </span>
            <h2>Start here</h2>
            <p>Ask about your workspace, or tell the assistant what to build.</p>
          </div>
        ) : null}
        {snapshot.view.items.map((item) => (
          <TranscriptItem item={item} key={item.key} />
        ))}
      </div>
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={submit}
        disabled={blocked}
        busy={busy}
        footer={`${props.workspaceName} · ${props.model}`}
        hint={
          props.archived
            ? "Unarchive to continue"
            : (snapshot.view.activeTurn?.phase ?? (submittedTurnId ? "Waiting for assistant" : undefined))
        }
      />
    </div>
  );
}

function TranscriptItem({ item }: { readonly item: ConversationViewItem }) {
  switch (item.kind) {
    case "user-message":
      return (
        <div className="tt-message tt-user-message">
          <span className="tt-message-label">You</span>
          <div>{item.text}</div>
        </div>
      );
    case "assistant-message":
      return (
        <div className="tt-message tt-assistant-message">
          <span className="tt-message-label">Assistant</span>
          <div>
            {item.text}
            {item.streaming ? <span className="tt-cursor">▋</span> : null}
          </div>
        </div>
      );
    case "tool-activity":
      return (
        <details className="tt-tool-activity">
          <summary>{item.summary}</summary>
          {item.calls.map((call) => (
            <div className="tt-tool-call" key={call.toolCallId}>
              <strong>
                {call.name} · {call.status}
              </strong>
              <pre>{JSON.stringify(call.detail, null, 2)}</pre>
            </div>
          ))}
        </details>
      );
    case "approval-request":
      return <div className="tt-status-line">Approval needed: {item.reason}</div>;
    case "turn-status":
      return item.status === "completed" ? null : (
        <div className="tt-status-line">
          Turn {item.status}: {item.error?.message ?? item.reason}
        </div>
      );
    case "session-boundary":
      return <div className="tt-status-line">{item.message}</div>;
  }
}

interface ComposerProps {
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly onSend: () => void | Promise<void>;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly footer: string;
  readonly hint?: string;
}

function Composer(props: ComposerProps) {
  return (
    <form
      className="tt-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSend();
      }}
    >
      <textarea
        aria-label="Message"
        placeholder="Ask anything about your workspace…"
        value={props.draft}
        onChange={(event) => props.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!props.disabled) void props.onSend();
          }
        }}
      />
      <div className="tt-composer-bottom">
        <span>{props.hint ?? props.footer}</span>
        <button type="submit" disabled={props.disabled || props.draft.trim().length === 0}>
          {props.busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
