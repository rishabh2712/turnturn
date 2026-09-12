import type { DurableRecord, LiveEvent } from "./protocol";

export interface TimelineItem {
  readonly key: string;
  readonly sequence?: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
}

export type ChatItem =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly role: "user" | "assistant";
      readonly turnId?: string;
      readonly text: string;
      readonly streaming?: boolean;
    }
  | {
      readonly kind: "event";
      readonly key: string;
      readonly tone: "tool" | "approval" | "status" | "error";
      readonly title: string;
      readonly detail?: string;
    };

type ChatEventItem = Extract<ChatItem, { readonly kind: "event" }>;

export interface ApprovalPrompt {
  readonly approvalId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly reason: string;
}

export function chatFromRecords(
  records: readonly DurableRecord[],
  liveEvents: readonly LiveEvent[],
): readonly ChatItem[] {
  const byTurn = new Map<string, ChatTurn>();
  const unscoped: ChatItem[] = [];

  for (const record of records) {
    const turnId = record.turnId;
    if (turnId === undefined) continue;
    const turn = ensureTurn(byTurn, turnId);
    applyRecordToTurn(turn, record);
  }

  for (const event of liveEvents) {
    const turnId = event.turnId;
    if (turnId === undefined) {
      unscoped.push(liveEventItem(event));
      continue;
    }
    const turn = ensureTurn(byTurn, turnId);
    applyLiveEventToTurn(turn, event);
  }

  return [...byTurn.values()]
    .sort((left, right) => left.order - right.order)
    .flatMap(turnToItems)
    .concat(unscoped);
}

export function timelineFromRecords(
  records: readonly DurableRecord[],
  liveEvents: readonly LiveEvent[],
): readonly TimelineItem[] {
  return [
    ...records.map((record) => ({
      key: `record:${record.sequence}`,
      sequence: record.sequence,
      type: record.type,
      title: record.type,
      detail: summarize(record.payload),
    })),
    ...liveEvents.map((event, index) => ({
      key: `live:${event.eventId}:${index}`,
      type: event.type,
      title: event.type,
      detail: summarize(event.payload),
    })),
  ];
}

interface ChatTurn {
  readonly turnId: string;
  order: number;
  userText?: string;
  assistantText?: string;
  liveAssistantText: string;
  assistantCompleted: boolean;
  readonly events: ChatEventItem[];
}

function ensureTurn(turns: Map<string, ChatTurn>, turnId: string): ChatTurn {
  const existing = turns.get(turnId);
  if (existing !== undefined) return existing;
  const created: ChatTurn = {
    turnId,
    order: Number.MAX_SAFE_INTEGER,
    liveAssistantText: "",
    assistantCompleted: false,
    events: [],
  };
  turns.set(turnId, created);
  return created;
}

function applyRecordToTurn(turn: ChatTurn, record: DurableRecord): void {
  turn.order = Math.min(turn.order, record.sequence);
  switch (record.type) {
    case "turn.started":
      if (typeof record.payload.input === "string") turn.userText = record.payload.input;
      return;
    case "user.input.accepted":
      if (typeof record.payload.text === "string") turn.userText = record.payload.text;
      return;
    case "assistant.message.completed":
      if (typeof record.payload.content === "string") {
        turn.assistantText = record.payload.content;
        turn.assistantCompleted = true;
      }
      return;
    case "tool.requested":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "tool",
        title: `Tool requested: ${String(record.payload.name ?? "unknown")}`,
        detail: JSON.stringify(record.payload.input ?? null),
      });
      return;
    case "tool.result.completed":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "tool",
        title: "Tool completed",
        detail: summarize(record.payload),
      });
      return;
    case "tool.result.failed":
    case "tool.result.denied":
    case "tool.result.aborted":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "error",
        title: record.type,
        detail: summarize(record.payload),
      });
      return;
    case "approval.requested":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "approval",
        title: "Approval requested",
        detail: summarize(record.payload),
      });
      return;
    case "turn.completed":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "status",
        title: "Turn completed",
        detail: summarize(record.payload),
      });
      return;
    case "turn.failed":
    case "turn.aborted":
      turn.events.push({
        kind: "event",
        key: `record:${record.sequence}`,
        tone: "error",
        title: record.type,
        detail: summarize(record.payload),
      });
      return;
    default:
      return;
  }
}

function applyLiveEventToTurn(turn: ChatTurn, event: LiveEvent): void {
  switch (event.type) {
    case "content.delta":
      if (typeof event.payload.text === "string" && !turn.assistantCompleted) {
        turn.liveAssistantText += event.payload.text;
      }
      return;
    case "tool.started":
      turn.events.push(liveEventItem(event, `Tool started: ${String(event.payload.name ?? "unknown")}`, "tool"));
      return;
    case "tool.progress":
    case "tool.completed":
      turn.events.push(liveEventItem(event, event.type, "tool"));
      return;
    case "tool.failed":
    case "turn.failed":
    case "turn.aborted":
      turn.events.push(liveEventItem(event, event.type, "error"));
      return;
    case "approval.requested":
      turn.events.push(liveEventItem(event, "Approval requested", "approval"));
      return;
    case "turn.completed":
      turn.events.push(liveEventItem(event, "Turn completed", "status"));
      return;
    default:
      return;
  }
}

function turnToItems(turn: ChatTurn): readonly ChatItem[] {
  const items: ChatItem[] = [];
  if (turn.userText !== undefined) {
    items.push({
      kind: "message",
      key: `user:${turn.turnId}`,
      role: "user",
      turnId: turn.turnId,
      text: turn.userText,
    });
  }

  const assistantText = turn.assistantText ?? turn.liveAssistantText;
  if (assistantText) {
    items.push({
      kind: "message",
      key: `assistant:${turn.turnId}:${turn.assistantCompleted ? "done" : "live"}`,
      role: "assistant",
      turnId: turn.turnId,
      text: assistantText,
      streaming: !turn.assistantCompleted,
    });
  }

  items.push(...dedupeEvents(turn.events));
  return items;
}

function dedupeEvents(items: readonly ChatEventItem[]): readonly ChatEventItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const fingerprint = `${item.kind}:${item.title}:${item.detail ?? ""}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function liveEventItem(
  event: LiveEvent,
  title = event.type,
  tone: "tool" | "approval" | "status" | "error" = "status",
): ChatEventItem {
  return {
    kind: "event",
    key: `live:${event.eventId}`,
    tone,
    title,
    detail: summarize(event.payload),
  };
}

export function pendingApprovalFrom(
  records: readonly DurableRecord[],
  liveEvents: readonly LiveEvent[],
): ApprovalPrompt | undefined {
  const resolved = new Set(
    records.filter((record) => record.type === "approval.resolved").map((record) => record.approvalId),
  );
  const durable = records
    .map(recordApproval)
    .filter((approval): approval is ApprovalPrompt => approval !== undefined)
    .reverse()
    .find((approval) => !resolved.has(approval.approvalId));
  if (durable !== undefined) return durable;

  return liveEvents
    .map(liveApproval)
    .filter((approval): approval is ApprovalPrompt => approval !== undefined)
    .reverse()
    .find((approval) => !resolved.has(approval.approvalId));
}

function recordApproval(record: DurableRecord): ApprovalPrompt | undefined {
  if (record.type !== "approval.requested") return undefined;
  const { approvalId, conversationId, sessionId, turnId, toolCallId } = record;
  if (
    approvalId === undefined ||
    conversationId === undefined ||
    sessionId === undefined ||
    turnId === undefined ||
    toolCallId === undefined
  ) {
    return undefined;
  }
  return {
    approvalId,
    conversationId,
    sessionId,
    turnId,
    toolCallId,
    reason: String(record.payload.reason ?? "Approval requested"),
  };
}

function liveApproval(event: LiveEvent): ApprovalPrompt | undefined {
  if (event.type !== "approval.requested") return undefined;
  const { approvalId, conversationId, sessionId, turnId, toolCallId } = event;
  if (
    approvalId === undefined ||
    conversationId === undefined ||
    sessionId === undefined ||
    turnId === undefined ||
    toolCallId === undefined
  ) {
    return undefined;
  }
  return {
    approvalId,
    conversationId,
    sessionId,
    turnId,
    toolCallId,
    reason: String(event.payload.reason ?? "Approval requested"),
  };
}

function summarize(payload: Record<string, unknown>): string | undefined {
  if ("text" in payload && typeof payload.text === "string") return payload.text;
  if ("input" in payload && typeof payload.input === "string") return payload.input;
  if ("content" in payload && typeof payload.content === "string") return payload.content;
  if ("reason" in payload && typeof payload.reason === "string") return payload.reason;
  if ("error" in payload) return JSON.stringify(payload.error);
  if ("name" in payload && typeof payload.name === "string") return payload.name;
  return JSON.stringify(payload);
}
