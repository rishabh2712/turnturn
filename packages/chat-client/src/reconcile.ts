import {
  type ConversationId,
  DurableRecordTypes as Durable,
  type DurableRecord,
  LiveEventTypes as Live,
  type LiveEvent,
  type SessionId,
  type TurnId,
} from "@turnturn/protocol";
import type { ProjectionIssue } from "./view-model.js";

export interface SessionSlice {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly provider?: string;
  readonly model?: string;
  readonly records: readonly DurableRecord[];
  readonly lastSequence: number;
  readonly hasGap: boolean;
  readonly live: readonly LiveEvent[];
  readonly diagnostics: readonly ProjectionIssue[];
  readonly optimistic?: { readonly turnId: TurnId; readonly text: string };
}

export function emptySessionSlice(conversationId: ConversationId, sessionId: SessionId, ordinal: number): SessionSlice {
  return { conversationId, sessionId, ordinal, records: [], lastSequence: 0, hasGap: false, live: [], diagnostics: [] };
}

export function ingestRecord(slice: SessionSlice, record: DurableRecord): SessionSlice {
  if (record.sessionId !== slice.sessionId || record.conversationId !== slice.conversationId) {
    return withIssue(slice, "foreign-session", "Record does not belong to this session", record);
  }
  if (record.sequence <= slice.lastSequence) {
    const held = slice.records.find((entry) => entry.sequence === record.sequence);
    if (held?.recordId === record.recordId) return slice;
    return withIssue(slice, "sequence-conflict", `Sequence ${record.sequence} has a different record`, record);
  }
  if (record.sequence > slice.lastSequence + 1) {
    return {
      ...withIssue(
        slice,
        "sequence-gap",
        `Expected sequence ${slice.lastSequence + 1}, got ${record.sequence}`,
        record,
      ),
      hasGap: true,
    };
  }
  return reconcileLive({
    ...slice,
    records: [...slice.records, record],
    lastSequence: record.sequence,
    hasGap: false,
  });
}

export function ingestLive(slice: SessionSlice, event: LiveEvent): SessionSlice {
  if (event.sessionId !== slice.sessionId || event.conversationId !== slice.conversationId) {
    return withIssue(slice, "foreign-live-event", "Live event does not belong to this session");
  }
  if (slice.live.some((held) => held.eventId === event.eventId)) return slice;
  return reconcileLive({ ...slice, live: [...slice.live, event] });
}

export function reconcileLive(slice: SessionSlice): SessionSlice {
  const messages = new Set<string>();
  const terminalTools = new Set<string>();
  const requestedApprovals = new Set<string>();
  const resolvedApprovals = new Set<string>();
  const startedTurns = new Set<string>();
  const terminalTurns = new Set<string>();
  for (const record of slice.records) {
    switch (record.type) {
      case Durable.AssistantMessageCompleted:
        if (record.stepId !== undefined) messages.add(record.stepId);
        break;
      case Durable.ToolResultCompleted:
      case Durable.ToolResultFailed:
      case Durable.ToolResultDenied:
      case Durable.ToolResultAborted:
        if (record.toolCallId !== undefined) terminalTools.add(record.toolCallId);
        break;
      case Durable.ApprovalRequested:
        if (record.approvalId !== undefined) requestedApprovals.add(record.approvalId);
        break;
      case Durable.ApprovalResolved:
        if (record.approvalId !== undefined) resolvedApprovals.add(record.approvalId);
        break;
      case Durable.TurnStarted:
        if (record.turnId !== undefined) startedTurns.add(record.turnId);
        break;
      case Durable.TurnCompleted:
      case Durable.TurnFailed:
      case Durable.TurnAborted:
        if (record.turnId !== undefined) terminalTurns.add(record.turnId);
        break;
      default:
        break;
    }
  }

  const issues: ProjectionIssue[] = [...slice.diagnostics];
  const retained: LiveEvent[] = [];
  for (const event of slice.live) {
    if (event.sessionId !== slice.sessionId || event.conversationId !== slice.conversationId) {
      issues.push({
        code: "foreign-live-event",
        message: "Live event does not belong to this session",
        sessionId: slice.sessionId,
      });
      continue;
    }
    if (event.type === Live.ContentDelta || event.type === Live.ReasoningDelta) {
      if (event.stepId !== undefined && messages.has(event.stepId)) continue;
      if (event.turnId !== undefined && terminalTurns.has(event.turnId)) {
        if (event.type === Live.ContentDelta && event.payload.text.length > 0) {
          issues.push({
            code: "live-text-unbacked",
            message: "Live assistant text has no durable message before the turn ended",
            sessionId: slice.sessionId,
            turnId: event.turnId,
          });
        }
        continue;
      }
    } else if (
      event.type === Live.ToolStarted ||
      event.type === Live.ToolProgress ||
      event.type === Live.StdoutDelta ||
      event.type === Live.StderrDelta ||
      event.type === Live.ToolCompleted ||
      event.type === Live.ToolFailed
    ) {
      if (event.toolCallId !== undefined && terminalTools.has(event.toolCallId)) continue;
    } else if (event.type === Live.ApprovalRequested) {
      if (event.approvalId !== undefined && requestedApprovals.has(event.approvalId)) continue;
    } else if (event.type === Live.ApprovalResolved) {
      if (event.approvalId !== undefined && resolvedApprovals.has(event.approvalId)) continue;
    } else if (event.type === Live.TurnStarted) {
      if (event.turnId !== undefined && startedTurns.has(event.turnId)) continue;
    } else if (event.type === Live.TurnCompleted || event.type === Live.TurnFailed || event.type === Live.TurnAborted) {
      if (event.turnId !== undefined && terminalTurns.has(event.turnId)) continue;
    }
    retained.push(event);
  }

  let warningCount = 0;
  const bounded = retained.filter((event) => {
    if (event.type !== Live.Warning) return true;
    warningCount += 1;
    return warningCount > retained.filter((candidate) => candidate.type === Live.Warning).length - 50;
  });
  return { ...slice, live: bounded, diagnostics: issues };
}

function withIssue(slice: SessionSlice, code: string, message: string, record?: DurableRecord): SessionSlice {
  return {
    ...slice,
    diagnostics: [
      ...slice.diagnostics,
      {
        code,
        message,
        sessionId: slice.sessionId,
        ...(record === undefined ? {} : { recordId: record.recordId }),
      },
    ],
  };
}
