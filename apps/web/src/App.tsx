import {
  type ChatTransport,
  ConversationStore,
  type ProviderCatalog,
  type TraceSelection,
} from "@turnturn/chat-client";
import type { ConversationId } from "@turnturn/protocol";
import { useEffect, useRef, useState } from "react";
import { sendTurn } from "./client-actions";
import { PendingActionBar } from "./components/approval/PendingActionBar";
import { TurnInspector } from "./components/developer/TurnInspector";
import { ModelPicker } from "./components/model/ModelPicker";
import { ConversationSidebar } from "./components/shell/ConversationSidebar";
import { TurnBlock } from "./components/turn/TurnBlock";
import { ConversationViewport } from "./components/viewport/ConversationViewport";
import { useConversationController } from "./features/conversation/useConversationController";
import { WorkspaceFilePeekProvider } from "./features/file-preview/WorkspaceFilePeekProvider";
import { ConversationListProvider, useConversationList } from "./providers/ConversationListProvider";
import { RuntimeProvider, useRuntime } from "./providers/RuntimeProvider";
import { useChatTransport } from "./providers/TransportProvider";
import "./styles.css";

/**
 * The single place holding provider-catalog state (5.4c.7) — `ModelPicker` only
 * renders what it is given. Discovery still runs server-side (D29); this just fetches
 * the safe, already-grouped snapshot.
 */
function useProviderCatalog(transport: ChatTransport) {
  const [catalog, setCatalog] = useState<ProviderCatalog | undefined>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    void transport.listProviders().then(
      (result) => {
        if (active) setCatalog(result);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [transport]);

  async function refresh() {
    setRefreshing(true);
    try {
      setCatalog(await transport.refreshProviders());
    } finally {
      setRefreshing(false);
    }
  }

  return { catalog, refresh, refreshing };
}

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
  const providerCatalog = useProviderCatalog(transport);
  const stores = useRef(new Map<ConversationId, ConversationStore>());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [newConversationModelId, setNewConversationModelId] = useState<string | undefined>();

  useEffect(() => {
    if (runtime.status === "ready" && newConversationModelId === undefined) {
      setNewConversationModelId(runtime.runtime.defaultModelProfileId);
    }
  }, [runtime, newConversationModelId]);

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
      await sendTurn(transport, storeFor(id), id, draft, newConversationModelId);
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
    <WorkspaceFilePeekProvider workspaceKey={runtime.status === "ready" ? runtime.runtime.workspace.key : undefined}>
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
              models={runtime.status === "ready" ? runtime.runtime.models : []}
              defaultModelProfileId={runtime.status === "ready" ? runtime.runtime.defaultModelProfileId : "default"}
              catalog={providerCatalog.catalog}
              onRefreshCatalog={providerCatalog.refresh}
              refreshingCatalog={providerCatalog.refreshing}
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
                footer={
                  runtime.status === "ready" ? `${runtime.runtime.workspace.name} · ${runtime.runtime.model}` : ""
                }
              />
              {runtime.status === "ready" ? (
                <ModelPicker
                  catalog={providerCatalog.catalog}
                  value={newConversationModelId ?? runtime.runtime.defaultModelProfileId}
                  onChange={setNewConversationModelId}
                  onRefresh={() => void providerCatalog.refresh()}
                  refreshing={providerCatalog.refreshing}
                />
              ) : null}
            </div>
          )}
        </main>
      </div>
    </WorkspaceFilePeekProvider>
  );
}

interface ConversationPaneProps {
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly archived: boolean;
  readonly store: ConversationStore;
  readonly transport: ChatTransport;
  readonly workspaceName: string;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly provider: string;
    readonly model: string;
  }[];
  readonly defaultModelProfileId: string;
  readonly catalog: ProviderCatalog | undefined;
  readonly onRefreshCatalog: () => Promise<void>;
  readonly refreshingCatalog: boolean;
  readonly onActivity: () => Promise<void>;
}

function ConversationPane(props: ConversationPaneProps) {
  const { conversationId, store, transport } = props;
  const [draft, setDraft] = useState("");
  const [traceSelection, setTraceSelection] = useState<TraceSelection | undefined>();
  const conversation = useConversationController({
    conversationId,
    store,
    transport,
    models: props.models,
    defaultModelProfileId: props.defaultModelProfileId,
    onActivity: props.onActivity,
    archived: props.archived,
  });
  const { snapshot, presentation, loading, error, busy, submittedTurnId, modelProfileId, connected, blocked } =
    conversation;
  const pendingApproval = conversation.pendingApproval;

  async function submit() {
    if (await conversation.submit(draft)) setDraft("");
  }

  return (
    <div className="tt-conversation">
      <header className="tt-header">
        <div className="tt-header-title">
          <h1>{props.title}</h1>
          <span className="tt-workspace-chip">{props.workspaceName}</span>
        </div>
        <div className="tt-header-meta">
          <ModelPicker
            disabled={blocked}
            disabledReason={blocked ? "Switching models is disabled while a turn is active." : undefined}
            catalog={props.catalog}
            currentLabel={props.models.find((profile) => profile.id === modelProfileId)?.model}
            value={modelProfileId}
            onChange={(value) => void conversation.switchModel(value)}
            onRefresh={() => void props.onRefreshCatalog()}
            refreshing={props.refreshingCatalog}
          />
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
      <ConversationViewport contentRevision={snapshot.view} itemCount={presentation.timeline.length}>
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
        {presentation.timeline.map((item) =>
          item.kind === "session-boundary" ? (
            <div className="tt-status-line" key={item.key}>
              {item.message}
            </div>
          ) : (
            <TurnBlock
              conversationId={conversationId}
              key={item.key}
              onInspect={setTraceSelection}
              onResolveApproval={conversation.answerApproval}
              approvalCommand={conversation.approvalCommand}
              approvalReceipts={conversation.approvalReceipts}
              turn={item}
            />
          ),
        )}
        {snapshot.view.activeTurn !== undefined || submittedTurnId !== undefined ? (
          <output className="tt-live-phase">
            <span className="tt-live-dot" aria-hidden="true" />
            {phaseLabel(snapshot.view.activeTurn?.phase ?? "waiting-for-model")}
          </output>
        ) : null}
      </ConversationViewport>
      {pendingApproval === undefined ? null : (
        <PendingActionBar
          item={pendingApproval}
          status={conversation.approvalCommand?.status ?? "pending"}
          error={conversation.approvalCommand?.message}
          onResolve={(decision) => conversation.answerApproval(pendingApproval, decision)}
        />
      )}
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={submit}
        onStop={conversation.canStop ? conversation.cancelActiveTurn : undefined}
        stopping={conversation.cancelPendingTurnId !== undefined}
        disabled={blocked}
        busy={busy}
        footer={`${props.workspaceName} · ${props.models.find((profile) => profile.id === modelProfileId)?.label ?? modelProfileId}`}
        hint={
          conversation.cancelPendingTurnId !== undefined
            ? "Stopping…"
            : props.archived
              ? "Unarchive to continue"
              : (snapshot.view.activeTurn?.phase ?? (submittedTurnId ? "Waiting for assistant" : undefined))
        }
      />
      {traceSelection === undefined ? null : (
        <TurnInspector
          lifecycleKey={`${snapshot.view.items.length}:${snapshot.view.activeTurn?.phase ?? "terminal"}`}
          onClose={() => setTraceSelection(undefined)}
          selection={traceSelection}
          transport={transport}
        />
      )}
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "waiting-for-model":
      return "Waiting for model…";
    case "generating":
      return "Writing response…";
    case "executing-tools":
      return "Using tools…";
    case "awaiting-approval":
      return "Waiting for your approval…";
    case "finishing":
      return "Finishing…";
    default:
      return phase;
  }
}

interface ComposerProps {
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly onSend: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
  readonly stopping?: boolean;
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
        {props.onStop === undefined ? (
          <button type="submit" disabled={props.disabled || props.draft.trim().length === 0}>
            {props.busy ? "Sending…" : "Send"}
          </button>
        ) : (
          <button type="button" disabled={props.stopping} onClick={() => void props.onStop?.()}>
            {props.stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
    </form>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
