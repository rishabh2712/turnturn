import type { ConversationSummary } from "@turnturn/chat-client";
import { type ConversationId, parseId } from "@turnturn/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRuntime } from "./RuntimeProvider";
import { useChatTransport } from "./TransportProvider";

interface ConversationListState {
  readonly conversations: readonly ConversationSummary[];
  readonly archivedConversations: readonly ConversationSummary[];
  readonly selectedId?: ConversationId;
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly select: (id: ConversationId) => void;
  readonly create: () => Promise<ConversationId>;
  readonly rename: (id: ConversationId, title: string) => Promise<void>;
  readonly archive: (id: ConversationId, archived: boolean) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const ConversationListContext = createContext<ConversationListState | null>(null);

function idFromLocation(): ConversationId | undefined {
  const match = /^\/c\/([^/]+)$/.exec(window.location.pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return parseId("conv", decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

export function ConversationListProvider({ children }: { readonly children: ReactNode }) {
  const transport = useChatTransport();
  const runtime = useRuntime();
  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<readonly ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<ConversationId | undefined>(idFromLocation);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const [active, archived] = await Promise.all([
        transport.listConversations(),
        transport.listConversations({ archived: true }),
      ]);
      setConversations(active.conversations);
      setArchivedConversations(archived.conversations);
      setStatus("ready");
      setError(undefined);
      setSelectedId((current) => {
        if (
          current !== undefined &&
          [...active.conversations, ...archived.conversations].some((c) => c.conversationId === current)
        )
          return current;
        return active.conversations[0]?.conversationId;
      });
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [transport]);

  useEffect(() => {
    if (runtime.status === "ready") void refresh();
  }, [refresh, runtime.status]);

  const select = useCallback((id: ConversationId) => {
    setSelectedId(id);
    window.history.pushState(null, "", `/c/${id}`);
  }, []);

  const create = useCallback(async (): Promise<ConversationId> => {
    if (runtime.status !== "ready") throw new Error("Workspace configuration is not loaded");
    const created = await transport.createConversation({ workspaceKey: runtime.runtime.workspace.key });
    await refresh();
    select(created.conversationId);
    return created.conversationId;
  }, [transport, runtime, refresh, select]);

  const rename = useCallback(
    async (id: ConversationId, title: string) => {
      await transport.patchConversation(id, { title });
      await refresh();
    },
    [transport, refresh],
  );

  const archive = useCallback(
    async (id: ConversationId, archived: boolean) => {
      await transport.patchConversation(id, { archived });
      await refresh();
    },
    [transport, refresh],
  );

  const value = useMemo<ConversationListState>(
    () => ({
      conversations,
      archivedConversations,
      ...(selectedId === undefined ? {} : { selectedId }),
      status,
      ...(error === undefined ? {} : { error }),
      select,
      create,
      rename,
      archive,
      refresh,
    }),
    [conversations, archivedConversations, selectedId, status, error, select, create, rename, archive, refresh],
  );

  return <ConversationListContext.Provider value={value}>{children}</ConversationListContext.Provider>;
}

export function useConversationList(): ConversationListState {
  const state = useContext(ConversationListContext);
  if (state === null) throw new Error("ConversationListProvider is missing");
  return state;
}
