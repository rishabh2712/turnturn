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

interface DurableFacts {
  readonly messages: ReadonlySet<string>;
  readonly terminalTools: ReadonlySet<string>;
  readonly requestedApprovals: ReadonlySet<string>;
  readonly resolvedApprovals: ReadonlySet<string>;
  readonly startedTurns: ReadonlySet<string>;
  readonly terminalTurns: ReadonlySet<string>;
}

/**
 * One row per live event type: what durable fact makes it redundant. A live event is
 * dropped once the durable record it was standing in for has arrived; `onDrop` lets a
 * rule raise a diagnostic instead of silently discarding real content.
 */
interface SupersessionRule {
  readonly name: string;
  readonly types: readonly Live[];
  readonly isSuperseded: (event: LiveEvent, facts: DurableFacts) => boolean;
  readonly onDrop?: (event: LiveEvent, facts: DurableFacts) => ProjectionIssue | undefined;
}

const SUPERSESSION_RULES: readonly SupersessionRule[] = [
  {
    name: "assistant-text-superseded-by-durable-message",
    types: [Live.ContentDelta, Live.ReasoningDelta],
    isSuperseded: (event, facts) =>
      (event.stepId !== undefined && facts.messages.has(event.stepId)) ||
      (event.turnId !== undefined && facts.terminalTurns.has(event.turnId)),
    onDrop: (event, facts) =>
      event.type === Live.ContentDelta &&
      event.turnId !== undefined &&
      facts.terminalTurns.has(event.turnId) &&
      event.payload.text.length > 0
        ? {
            code: "live-text-unbacked",
            message: "Live assistant text has no durable message before the turn ended",
            turnId: event.turnId,
          }
        : undefined,
  },
  {
    name: "tool-activity-superseded-by-terminal-result",
    types: [
      Live.ToolStarted,
      Live.ToolProgress,
      Live.StdoutDelta,
      Live.StderrDelta,
      Live.ToolCompleted,
      Live.ToolFailed,
    ],
    isSuperseded: (event, facts) => event.toolCallId !== undefined && facts.terminalTools.has(event.toolCallId),
  },
  {
    name: "approval-request-superseded-by-durable-request",
    types: [Live.ApprovalRequested],
    isSuperseded: (event, facts) => event.approvalId !== undefined && facts.requestedApprovals.has(event.approvalId),
  },
  {
    name: "approval-resolution-superseded-by-durable-resolution",
    types: [Live.ApprovalResolved],
    isSuperseded: (event, facts) => event.approvalId !== undefined && facts.resolvedApprovals.has(event.approvalId),
  },
  {
    name: "turn-start-superseded-by-durable-start",
    types: [Live.TurnStarted],
    isSuperseded: (event, facts) => event.turnId !== undefined && facts.startedTurns.has(event.turnId),
  },
  {
    name: "turn-terminal-superseded-by-durable-terminal",
    types: [Live.TurnCompleted, Live.TurnFailed, Live.TurnAborted],
    isSuperseded: (event, facts) => event.turnId !== undefined && facts.terminalTurns.has(event.turnId),
  },
];

const RULE_BY_TYPE = new Map<Live, SupersessionRule>(
  SUPERSESSION_RULES.flatMap((rule) => rule.types.map((type) => [type, rule] as const)),
);

export function reconcileLive(slice: SessionSlice): SessionSlice {
  const facts = collectDurableFacts(slice.records);

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
    const rule = RULE_BY_TYPE.get(event.type);
    if (rule?.isSuperseded(event, facts)) {
      const issue = rule.onDrop?.(event, facts);
      if (issue !== undefined) issues.push({ ...issue, sessionId: slice.sessionId });
      continue;
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

function collectDurableFacts(records: readonly DurableRecord[]): DurableFacts {
  const messages = new Set<string>();
  const terminalTools = new Set<string>();
  const requestedApprovals = new Set<string>();
  const resolvedApprovals = new Set<string>();
  const startedTurns = new Set<string>();
  const terminalTurns = new Set<string>();
  for (const record of records) {
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
  return { messages, terminalTools, requestedApprovals, resolvedApprovals, startedTurns, terminalTurns };
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
