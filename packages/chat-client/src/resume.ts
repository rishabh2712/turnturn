import type { ConversationId, SessionId } from "@turnturn/protocol";
import type { ConversationStore } from "./store.js";
import type { ChatTransport, SnapshotFrame } from "./transport.js";

export interface ResumeController {
  /** Closes the live subscription and stops replaying. Idempotent. */
  readonly stop: () => void;
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
 * Live events are pure forwarding: never replayed, never trusted once a durable
 * record supersedes them (reconcile.ts already enforces that), so a missed one during
 * a disconnect simply never rendered — nothing to recover.
 */
export function resumeConversation(
  transport: ChatTransport,
  store: ConversationStore,
  conversationId: ConversationId,
): ResumeController {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();

  const unsubscribe = transport.subscribeEvents(conversationId, {
    onSnapshot: (frame) => {
      if (stopped) return;
      // Snapshots can arrive back-to-back on a flappy connection; serialize handling
      // so a later snapshot's catch-up can't interleave with an earlier one's.
      pending = pending.then(() => (stopped ? undefined : handleSnapshot(frame)));
    },
    onEvent: (event) => {
      if (stopped || event.sessionId === undefined) return;
      store.ingestLive(event.sessionId, event);
    },
    onError: () => {
      if (stopped) return;
      const { connection } = store.getSnapshot();
      store.setConnection({ ...connection, status: "reconnecting" });
    },
  });

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
      after = page.lastSequence;
      if (!page.hasMore) return;
    }
  }

  return {
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
