import { type CommandEnvelope, type ConversationId, LiveEventTypes as Live, type SessionId } from "@turnturn/protocol";
import type {
  ActivateResult,
  ChatTransport,
  ConversationDetail,
  ConversationListPage,
  ConversationSummary,
  CreateConversationParams,
  ListConversationsParams,
  LiveSubscriptionHandlers,
  PatchConversationParams,
  RecordsPage,
  RuntimeInfo,
  TransportCommandResult,
  WorkspaceFile,
} from "./transport.js";

/** Thrown for any non-2xx REST response. Carries the server's error code, not just the HTTP status. */
export class TransportHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TransportHttpError";
  }
}

export interface HttpChatTransportOptions {
  /** Same-origin by default (empty string) — set for a non-default host during tests. */
  readonly baseUrl?: string;
  readonly token: string;
}

/**
 * The one real `ChatTransport` (D21): REST over `fetch`, live updates over
 * `EventSource`. No component imports this directly — the store is the seam
 * everything else sees.
 */
export class HttpChatTransport implements ChatTransport {
  constructor(private readonly options: HttpChatTransportOptions) {}

  getRuntime(): Promise<RuntimeInfo> {
    return this.request("GET", "/api/runtime");
  }

  listConversations(params: ListConversationsParams = {}): Promise<ConversationListPage> {
    return this.request("GET", `/api/conversations?${query(params)}`);
  }

  createConversation(params: CreateConversationParams): Promise<ConversationSummary> {
    return this.request("POST", "/api/conversations", params);
  }

  getConversation(conversationId: ConversationId): Promise<ConversationDetail> {
    return this.request("GET", `/api/conversations/${conversationId}`);
  }

  activateConversation(conversationId: ConversationId): Promise<ActivateResult> {
    return this.request("POST", `/api/conversations/${conversationId}/activate`);
  }

  patchConversation(conversationId: ConversationId, patch: PatchConversationParams): Promise<ConversationSummary> {
    return this.request("PATCH", `/api/conversations/${conversationId}`, patch);
  }

  async deleteConversation(conversationId: ConversationId): Promise<void> {
    await this.request("DELETE", `/api/conversations/${conversationId}`);
  }

  getRecords(
    conversationId: ConversationId,
    sessionId: SessionId,
    afterSequence: number,
    limit?: number,
  ): Promise<RecordsPage> {
    const params = limit === undefined ? { afterSequence } : { afterSequence, limit };
    return this.request("GET", `/api/conversations/${conversationId}/sessions/${sessionId}/records?${query(params)}`);
  }

  submitCommand(command: CommandEnvelope): Promise<TransportCommandResult> {
    return this.request("POST", "/commands", command);
  }

  getWorkspaceFile(workspaceKey: string, path: string, start?: number, end?: number): Promise<WorkspaceFile> {
    const params = { path, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
    return this.request("GET", `/api/workspaces/${workspaceKey}/file?${query(params)}`);
  }

  subscribeEvents(conversationId: ConversationId, handlers: LiveSubscriptionHandlers): () => void {
    const url = `${this.options.baseUrl ?? ""}/events?${query({ conversationId, token: this.options.token })}`;
    const source = new EventSource(url);

    const onSnapshot = (message: MessageEvent<string>) => handlers.onSnapshot(JSON.parse(message.data));
    source.addEventListener("snapshot", onSnapshot);

    const liveTypes = Object.values(Live);
    const onLiveEvent = (message: MessageEvent<string>) => handlers.onEvent(JSON.parse(message.data));
    for (const type of liveTypes) source.addEventListener(type, onLiveEvent);

    // EventSource retries on its own after a network error (browser behavior, not
    // ours to control) — onError just reports the degraded state; a future
    // onSnapshot, once the browser reconnects, is what actually recovers it.
    source.addEventListener("error", handlers.onError);

    return () => {
      source.removeEventListener("snapshot", onSnapshot);
      for (const type of liveTypes) source.removeEventListener(type, onLiveEvent);
      source.removeEventListener("error", handlers.onError);
      source.close();
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.options.baseUrl ?? ""}${path}`, {
      method,
      headers: {
        "x-turnturn-token": this.options.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = parseJsonBody(text);
    if (!response.ok) {
      const error = isErrorEnvelope(parsed) ? parsed.error : undefined;
      throw new TransportHttpError(
        error?.code ?? "UNKNOWN_ERROR",
        error?.message ?? (text.length > 0 ? text : `Request failed with status ${response.status}`),
        response.status,
      );
    }
    return parsed as T;
  }
}

// Deliberately typed as `object` rather than `Record<string, ...>`: named param
// interfaces like ListConversationsParams have no index signature, and TS won't
// structurally match them against a Record type without one.
function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

// The server always sends JSON on success, but an unhandled error path (a proxy, a
// crash) can produce a plain-text or empty body — parse defensively rather than
// letting a malformed error response itself throw an unrelated SyntaxError.
function parseJsonBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isErrorEnvelope(
  value: unknown,
): value is { readonly error: { readonly code: string; readonly message?: string } } {
  return typeof value === "object" && value !== null && "error" in value;
}
