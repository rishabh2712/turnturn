import {
  type ApprovalRequestItem,
  type ApprovalView,
  type ChatTransport,
  type ConversationStore,
  composeConversationPresentation,
  type ResumeController,
  resumeConversation,
} from "@turnturn/chat-client";
import type { ApprovalDecisions, ApprovalId, ConversationId, ToolCallId, TurnId } from "@turnturn/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { requestTurnCancel, resolveApproval, sendTurn } from "../../client-actions";

interface ModelProfile {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
}

interface ConversationControllerOptions {
  readonly conversationId: ConversationId;
  readonly store: ConversationStore;
  readonly transport: ChatTransport;
  readonly models: readonly ModelProfile[];
  readonly defaultModelProfileId: string;
  readonly onActivity: () => Promise<void>;
  readonly archived?: boolean;
}

/** Coordinates one selected conversation; durable facts remain in ConversationStore. */
export function useConversationController(options: ConversationControllerOptions) {
  const { conversationId, store, transport } = options;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [submittedTurnId, setSubmittedTurnId] = useState<TurnId | undefined>();
  const [cancelPendingTurnId, setCancelPendingTurnId] = useState<TurnId | undefined>();
  const [approvalCommand, setApprovalCommand] = useState<{
    readonly approvalId: ApprovalId;
    readonly status: "resolving" | "stale" | "error";
    readonly message?: string;
  }>();
  const [modelProfileId, setModelProfileId] = useState(options.defaultModelProfileId);
  const resume = useRef<ResumeController | undefined>(undefined);
  const cancelRequested = useRef<TurnId | undefined>(undefined);
  const approvalRequested = useRef<ApprovalId | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void transport.getConversation(conversationId).then(
      (detail) => {
        if (!active) return;
        for (const session of detail.sessions) {
          store.registerSession(session.sessionId, session.ordinal, session.provider, session.model);
        }
        const latest = detail.sessions.at(-1);
        setModelProfileId(
          latest?.modelProfileId ??
            options.models.find((profile) => profile.provider === latest?.provider && profile.model === latest?.model)
              ?.id ??
            options.defaultModelProfileId,
        );
        resume.current = resumeConversation(transport, store, conversationId);
        stop = resume.current.stop;
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
      resume.current = undefined;
    };
  }, [transport, store, conversationId]);

  useEffect(() => {
    if (submittedTurnId === undefined) return;
    if (snapshot.view.items.some((item) => item.kind === "turn-status" && item.turnId === submittedTurnId)) {
      setSubmittedTurnId(undefined);
    }
  }, [snapshot.view.items, submittedTurnId]);

  useEffect(() => {
    if (cancelPendingTurnId === undefined) return;
    if (snapshot.view.items.some((item) => item.kind === "turn-status" && item.turnId === cancelPendingTurnId)) {
      cancelRequested.current = undefined;
      setCancelPendingTurnId(undefined);
    }
  }, [snapshot.view.items, cancelPendingTurnId]);

  useEffect(() => {
    if (approvalCommand === undefined || snapshot.view.pendingApproval?.approvalId === approvalCommand.approvalId)
      return;
    approvalRequested.current = undefined;
    setApprovalCommand(undefined);
  }, [snapshot.view.pendingApproval?.approvalId, approvalCommand]);

  const presentation = composeConversationPresentation(snapshot.view);
  const connected = snapshot.connection.status === "connected";
  const canSend = !loading && !options.archived && (connected || snapshot.connection.status === "connecting");
  const blocked = busy || submittedTurnId !== undefined || snapshot.view.activeTurn !== undefined || !canSend;
  const activeTurn = snapshot.view.activeTurn;
  const cancellableTurn =
    activeTurn?.canStop && !options.archived
      ? presentation.timeline.find((item) => item.kind === "turn" && item.turnId === activeTurn.turnId)
      : undefined;

  async function submit(input: string): Promise<boolean> {
    if (blocked || input.trim().length === 0) return false;
    setBusy(true);
    setError(undefined);
    try {
      const turnId = await sendTurn(transport, store, conversationId, input, modelProfileId);
      setSubmittedTurnId(turnId);
      try {
        await options.onActivity();
      } catch (cause) {
        setError(messageOf(cause));
      }
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function cancelActiveTurn(): Promise<void> {
    if (cancellableTurn?.kind !== "turn" || cancelRequested.current !== undefined) return;
    const { sessionId, turnId } = cancellableTurn;
    cancelRequested.current = turnId;
    setCancelPendingTurnId(turnId);
    setError(undefined);
    let accepted = false;
    try {
      const result = await requestTurnCancel(transport, conversationId, sessionId, turnId);
      accepted = result.kind !== "rejected";
      await resume.current?.refresh(sessionId);
      if (result.kind === "rejected") {
        const terminal = store
          .getSnapshot()
          .view.items.some((item) => item.kind === "turn-status" && item.turnId === turnId);
        if (!terminal) throw new Error(`${result.code}: ${result.message}`);
      }
    } catch (cause) {
      setError(messageOf(cause));
      if (!accepted) {
        cancelRequested.current = undefined;
        setCancelPendingTurnId(undefined);
      }
    }
  }

  async function answerApproval(item: ApprovalRequestItem, decision: ApprovalDecisions): Promise<void> {
    if (
      store.getSnapshot().view.pendingApproval?.approvalId !== item.approvalId ||
      approvalRequested.current !== undefined
    )
      return;
    approvalRequested.current = item.approvalId;
    setApprovalCommand({ approvalId: item.approvalId, status: "resolving" });
    let outcome: "accepted" | "cancelled" | undefined;
    try {
      outcome = await resolveApproval(transport, conversationId, item, decision);
      await resume.current?.refresh(item.sessionId);
      if (outcome === "cancelled" && store.getSnapshot().view.pendingApproval?.approvalId === item.approvalId) {
        setApprovalCommand({ approvalId: item.approvalId, status: "stale" });
        approvalRequested.current = undefined;
      }
    } catch (cause) {
      if (store.getSnapshot().view.pendingApproval?.approvalId === item.approvalId) {
        setApprovalCommand({
          approvalId: item.approvalId,
          status: outcome === "accepted" ? "resolving" : outcome === "cancelled" ? "stale" : "error",
          message:
            outcome === "accepted"
              ? `Decision sent; waiting for saved confirmation. ${messageOf(cause)}`
              : messageOf(cause),
        });
      }
      if (outcome !== "accepted") approvalRequested.current = undefined;
    }
  }

  async function switchModel(nextProfileId: string): Promise<void> {
    if (blocked || nextProfileId === modelProfileId) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await transport.activateConversation(conversationId, { modelProfileId: nextProfileId });
      store.registerSession(session.sessionId, session.ordinal, session.provider, session.model);
      setModelProfileId(nextProfileId);
      await resume.current?.refresh(session.sessionId);
      await options.onActivity();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    snapshot,
    presentation,
    loading,
    error,
    busy,
    submittedTurnId,
    cancelPendingTurnId,
    canStop: cancellableTurn !== undefined,
    pendingApproval: snapshot.view.pendingApproval,
    approvalCommand:
      approvalCommand?.approvalId === snapshot.view.pendingApproval?.approvalId ? approvalCommand : undefined,
    approvalReceipts: new Map<ToolCallId, ApprovalView>(
      snapshot.view.items
        .filter((item) => item.kind === "tool-activity")
        .flatMap((item) => item.calls)
        .filter((call) => call.approval !== undefined && call.approval.status !== "pending")
        .map((call) => [call.toolCallId, call.approval as ApprovalView]),
    ),
    modelProfileId,
    connected,
    blocked,
    submit,
    cancelActiveTurn,
    answerApproval,
    switchModel,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
