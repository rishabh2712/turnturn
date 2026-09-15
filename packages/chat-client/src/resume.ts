import { type ConversationId, type LiveEvent, LiveEventTypes, type SessionId } from "@turnturn/protocol";
import type { ConversationStore } from "./store.js";
import type { ChatTransport, SnapshotFrame } from "./transport.js";

export interface ResumeController {
  /** Closes the live subscription and stops replaying. Idempotent. */
  readonly stop: () => void;
  /** Explicit catch-up after a command, including when its live event was missed. */
  readonly refresh: (sessionId: SessionId) => Promise<void>;
}

/**
 * Drives one conversation's store from one transport (D8, D9, D21): subscribes to the
 * live stream, and on every `snapshot` frame, catches the store up on any durable
 * records it's missing per session before trusting live events again. A
 * `serverInstanceId` change from the previously known one means the server restarted
 * (D8) — session live state may reference work the restart already resolved, so it's
 * dropped rather than trusted; the durable catch-up (which always runs) is what
 * actually re-establishes truth, since sequences never renumber.
 *
 * Live text is forwarded immediately. Lifecycle announcements also trigger a durable
 * catch-up, because the transcript and actionable approvals come from records, not
 * from the ephemeral event. Events arriving during snapshot replay are held until
 * that replay finishes so they cannot be superseded out of order.
 */
export function resumeConversation(
  transport: ChatTransport,
  store: ConversationStore,
  conversationId: ConversationId,
): ResumeController {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let syncing = true;
  const buffered: LiveEvent[] = [];

  function enqueue(work: () => Promise<void>): Promise<void> {
    const task = pending.then(work);
    pending = task.catch(() => {
      if (stopped) return;
      const { connection } = store.getSnapshot();
      store.setConnection({ ...connection, status: "reconnecting" });
    });
    return task;
  }

  const unsubscribe = transport.subscribeEvents(conversationId, {
    onSnapshot: (frame) => {
      if (stopped) return;
      syncing = true;
      // Snapshots can arrive back-to-back on a flappy connection; serialize handling
      // so a later snapshot's catch-up can't interleave with an earlier one's.
      void enqueue(async () => {
        if (stopped) return;
        await handleSnapshot(frame);
        if (stopped) return;
        syncing = false;
        for (const event of buffered.splice(0)) receiveEvent(event);
      }).catch(() => {});
    },
    onEvent: (event) => {
      if (stopped || event.sessionId === undefined) return;
      if (syncing) buffered.push(event);
      else receiveEvent(event);
    },
    onError: () => {
      if (stopped) return;
      const { connection } = store.getSnapshot();
      store.setConnection({ ...connection, status: "reconnecting" });
    },
  });

  function receiveEvent(event: LiveEvent): void {
    if (stopped || event.sessionId === undefined) return;
    store.ingestLive(event.sessionId, event);
    if (needsDurableCatchUp(event.type)) {
      const sessionId = event.sessionId;
      void enqueue(() => catchUpSession(sessionId)).catch(() => {});
    }
  }

  async function handleSnapshot(frame: SnapshotFrame): Promise<void> {
    const previousInstanceId = store.getSnapshot().connection.serverInstanceId;
    const restarted = previousInstanceId !== undefined && previousInstanceId !== frame.serverInstanceId;
    if (restarted) {
      for (const session of frame.sessions) store.clearLive(session.sessionId);
    }
    for (const session of frame.sessions) {
      if (stopped) return;
      await replaySession(session.sessionId, session.lastSequence);
    }
    if (!stopped) store.setConnection({ status: "connected", serverInstanceId: frame.serverInstanceId });
  }

  async function replaySession(sessionId: SessionId, serverLastSequence: number): Promise<void> {
    let after = store.lastSequenceFor(sessionId);
    while (after < serverLastSequence && !stopped) {
      const page = await transport.getRecords(conversationId, sessionId, after);
      for (const record of page.records) store.ingestRecord(sessionId, record);
      if (page.records.length === 0) return; // nothing left to fetch; avoid spinning
      after = page.records.at(-1)?.sequence ?? after;
      if (!page.hasMore) return;
    }
  }

  async function catchUpSession(sessionId: SessionId): Promise<void> {
    let after = store.lastSequenceFor(sessionId);
    while (!stopped) {
      const page = await transport.getRecords(conversationId, sessionId, after);
      for (const record of page.records) store.ingestRecord(sessionId, record);
      if (page.records.length === 0 || !page.hasMore) return;
      after = page.records.at(-1)?.sequence ?? after;
    }
  }

  return {
    refresh: (sessionId) => {
      if (stopped) return Promise.resolve();
      return enqueue(() => catchUpSession(sessionId));
    },
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

function needsDurableCatchUp(type: LiveEventTypes): boolean {
  return (
    type === LiveEventTypes.TurnStarted ||
    type === LiveEventTypes.ToolStarted ||
    type === LiveEventTypes.ToolCompleted ||
    type === LiveEventTypes.ToolFailed ||
    type === LiveEventTypes.ApprovalRequested ||
    type === LiveEventTypes.ApprovalResolved ||
    type === LiveEventTypes.TurnCompleted ||
    type === LiveEventTypes.TurnFailed ||
    type === LiveEventTypes.TurnAborted
  );
}
