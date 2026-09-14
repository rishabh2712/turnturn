import type { ConversationId, DurableRecord, LiveEvent, SessionId, TurnId } from "@turnturn/protocol";
import { projectConversation } from "./projector.js";
import { emptySessionSlice, ingestLive, ingestRecord, type SessionSlice } from "./reconcile.js";
import type { ConversationView } from "./view-model.js";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly serverInstanceId?: string;
}

export interface ConversationMetadata {
  readonly conversationId: ConversationId;
  readonly title?: string;
  readonly workspace?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface StoreSnapshot {
  readonly view: ConversationView;
  readonly connection: ConnectionState;
  readonly metadata: ConversationMetadata | undefined;
}

/**
 * The one stateful, mutable piece of `chat-client`. Holds one conversation's session
 * slices and delegates every actual rule to `reconcile.ts`/`projector.ts`, which stay
 * pure. Exposes exactly the `subscribe`/`getSnapshot` shape `useSyncExternalStore`
 * needs — nothing here knows about React, and nothing here talks to the network; a
 * transport calls these methods from outside as data arrives.
 */
export class ConversationStore {
  private readonly conversationId: ConversationId;
  private readonly slices = new Map<SessionId, SessionSlice>();
  private readonly listeners = new Set<() => void>();
  private snapshot: StoreSnapshot;
  private viewDirty = false;

  constructor(conversationId: ConversationId) {
    this.conversationId = conversationId;
    this.snapshot = {
      view: projectConversation(conversationId, []),
      connection: { status: "connecting" },
      metadata: undefined,
    };
  }

  registerSession(sessionId: SessionId, ordinal: number, provider?: string, model?: string): void {
    const base = this.slices.get(sessionId) ?? emptySessionSlice(this.conversationId, sessionId, ordinal);
    this.slices.set(sessionId, {
      ...base,
      ordinal,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    });
    this.markViewDirty();
  }

  ingestRecord(sessionId: SessionId, record: DurableRecord): void {
    const current = this.sliceFor(sessionId);
    const next = ingestRecord(current, record);
    if (next === current) return;
    this.slices.set(sessionId, next);
    this.markViewDirty();
  }

  ingestLive(sessionId: SessionId, event: LiveEvent): void {
    const current = this.sliceFor(sessionId);
    const next = ingestLive(current, event);
    if (next === current) return;
    this.slices.set(sessionId, next);
    this.markViewDirty();
  }

  setOptimistic(sessionId: SessionId, turnId: TurnId, text: string): void {
    const current = this.sliceFor(sessionId);
    if (current.optimistic?.turnId === turnId && current.optimistic.text === text) return;
    this.slices.set(sessionId, { ...current, optimistic: { turnId, text } });
    this.markViewDirty();
  }

  clearOptimistic(sessionId: SessionId): void {
    const current = this.slices.get(sessionId);
    if (current?.optimistic === undefined) return;
    const { optimistic: _cleared, ...rest } = current;
    this.slices.set(sessionId, rest);
    this.markViewDirty();
  }

  setConnection(state: ConnectionState): void {
    const current = this.snapshot.connection;
    if (current.status === state.status && current.serverInstanceId === state.serverInstanceId) return;
    this.snapshot = { ...this.snapshot, connection: state };
    this.notify();
  }

  setMetadata(metadata: ConversationMetadata): void {
    this.snapshot = { ...this.snapshot, metadata };
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreSnapshot => {
    if (this.viewDirty) {
      this.snapshot = { ...this.snapshot, view: projectConversation(this.conversationId, [...this.slices.values()]) };
      this.viewDirty = false;
    }
    return this.snapshot;
  };

  private sliceFor(sessionId: SessionId): SessionSlice {
    const existing = this.slices.get(sessionId);
    if (existing !== undefined) return existing;
    const created = emptySessionSlice(this.conversationId, sessionId, this.slices.size);
    this.slices.set(sessionId, created);
    return created;
  }

  private markViewDirty(): void {
    this.viewDirty = true;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
