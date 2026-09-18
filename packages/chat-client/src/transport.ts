import type { CommandEnvelope, ConversationId, DurableRecord, LiveEvent, SessionId } from "@turnturn/protocol";
import type { TraceDetailResponse, TraceListResponse, TracePayloadResponse } from "./trace-types.js";

export interface WorkspaceSummary {
  readonly key: string;
  readonly path: string;
  readonly name: string;
}

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
}

export interface RuntimeInfo {
  readonly workspace: WorkspaceSummary;
  readonly provider: string;
  readonly model: string;
  readonly baseUrlHost: string | null;
  readonly maxTokens: number | null;
  readonly serverInstanceId: string;
  readonly storageVersion: number;
  readonly schemaVersion: number;
  readonly tools: readonly ToolSummary[];
}

export interface ConversationSummary {
  readonly conversationId: ConversationId;
  readonly workspaceKey: string;
  readonly title: string | null;
  readonly titleSource: "auto" | "manual";
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly archived: boolean;
  readonly sessionCount: number;
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: string;
  readonly lastSequence: number;
}

export interface ConversationDetail {
  readonly conversation: ConversationSummary;
  readonly sessions: readonly SessionSummary[];
}

export interface ConversationListPage {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: string | null;
}

export interface ListConversationsParams {
  readonly archived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CreateConversationParams {
  readonly workspaceKey: string;
  readonly title?: string;
}

export interface PatchConversationParams {
  readonly title?: string;
  readonly archived?: boolean;
}

export interface ActivateResult {
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly provider: string;
  readonly model: string;
  readonly isNewSession: boolean;
}

export interface RecordsPage {
  readonly sessionId: SessionId;
  readonly records: readonly DurableRecord[];
  readonly lastSequence: number;
  readonly hasMore: boolean;
}

// Named TransportCommandResult, not CommandOutcome — that name belongs to
// assistant-core/src/ports.ts, and the no-duplicate-contract guard (task 12.5)
// forbids redeclaring it outside packages/protocol.
export type TransportCommandResult =
  | { readonly kind: "accepted"; readonly turnId?: string }
  | { readonly kind: "duplicate"; readonly records?: readonly DurableRecord[] }
  | { readonly kind: "rejected"; readonly code: string; readonly message: string };

/** The `event: snapshot` frame described in design.md D8 — one cursor per session. */
export interface SnapshotFrame {
  readonly conversationId: ConversationId;
  readonly serverInstanceId: string;
  readonly sessions: readonly { readonly sessionId: SessionId; readonly lastSequence: number }[];
}

export interface LiveSubscriptionHandlers {
  readonly onSnapshot: (frame: SnapshotFrame) => void;
  readonly onEvent: (event: LiveEvent) => void;
  readonly onError: (error: unknown) => void;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly lineCount: number;
  readonly content: string;
}

/**
 * Everything the client needs to talk to a server, named as an interface rather than
 * coupled to `fetch`/`EventSource` (D21). `HttpChatTransport` is the only real
 * implementation; a fake implementing this same interface is what lets `resume.ts`
 * and the conversation-mixing test run without a server.
 */
export interface ChatTransport {
  getRuntime(): Promise<RuntimeInfo>;
  listConversations(params?: ListConversationsParams): Promise<ConversationListPage>;
  createConversation(params: CreateConversationParams): Promise<ConversationSummary>;
  getConversation(conversationId: ConversationId): Promise<ConversationDetail>;
  activateConversation(conversationId: ConversationId): Promise<ActivateResult>;
  patchConversation(conversationId: ConversationId, patch: PatchConversationParams): Promise<ConversationSummary>;
  deleteConversation(conversationId: ConversationId): Promise<void>;
  getRecords(
    conversationId: ConversationId,
    sessionId: SessionId,
    afterSequence: number,
    limit?: number,
  ): Promise<RecordsPage>;
  submitCommand(command: CommandEnvelope): Promise<TransportCommandResult>;
  getWorkspaceFile(workspaceKey: string, path: string, start?: number, end?: number): Promise<WorkspaceFile>;
  listTraces(conversationId: ConversationId, sessionId: SessionId, turnId?: string): Promise<TraceListResponse>;
  getTrace(
    conversationId: ConversationId,
    sessionId: SessionId,
    traceId: string,
    afterTraceSequence?: number,
  ): Promise<TraceDetailResponse>;
  getTracePayload(
    conversationId: ConversationId,
    sessionId: SessionId,
    traceId: string,
    payloadId: string,
  ): Promise<TracePayloadResponse>;
  /** Opens (or reuses) the live event stream for a conversation. Returns an unsubscribe function. */
  subscribeEvents(conversationId: ConversationId, handlers: LiveSubscriptionHandlers): () => void;
}
