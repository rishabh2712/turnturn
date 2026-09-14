import {
  ApprovalDecisions,
  type ConversationId,
  DurableRecordTypes as Durable,
  type DurableRecord,
  LiveEventTypes as Live,
  type LiveEvent,
  type StepId,
  type ToolCallId,
  type TurnId,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reconcileLive, type SessionSlice } from "./reconcile.js";
import type {
  ApprovalRequestItem,
  ApprovalView,
  AssistantMessageItem,
  ConversationView,
  ConversationViewItem,
  OrderKey,
  ProjectionIssue,
  ToolActivityGroupItem,
  ToolCallStatus,
  ToolCallView,
  ToolGroupStatus,
  TurnPhase,
  TurnStatusItem,
  UserMessageItem,
} from "./view-model.js";

type ToolRequest = DurableRecord<Durable.ToolRequested>;
type ToolResult = DurableRecord<
  Durable.ToolResultCompleted | Durable.ToolResultFailed | Durable.ToolResultDenied | Durable.ToolResultAborted
>;
type ApprovalRequest = DurableRecord<Durable.ApprovalRequested>;
type ApprovalResolution = DurableRecord<Durable.ApprovalResolved>;

interface SessionProjection {
  readonly items: readonly ConversationViewItem[];
  readonly diagnostics: readonly ProjectionIssue[];
  readonly activeTurn?: ConversationView["activeTurn"];
  readonly pendingApproval?: ApprovalRequestItem;
}

export function projectConversation(conversationId: ConversationId, slices: readonly SessionSlice[]): ConversationView {
  const items: ConversationViewItem[] = [];
  const diagnostics: ProjectionIssue[] = [];
  let activeTurn: ConversationView["activeTurn"];
  let pendingApproval: ApprovalRequestItem | undefined;
  for (const slice of [...slices].sort((a, b) => a.ordinal - b.ordinal)) {
    if (slice.conversationId !== conversationId) {
      diagnostics.push({
        code: "foreign-conversation",
        message: "Session slice belongs to another conversation",
        sessionId: slice.sessionId,
      });
      continue;
    }
    const projected = projectSession(slice);
    items.push(...projected.items);
    diagnostics.push(...projected.diagnostics);
    if (projected.activeTurn !== undefined) activeTurn = projected.activeTurn;
    if (projected.pendingApproval !== undefined) pendingApproval = projected.pendingApproval;
  }
  items.sort((a, b) => compareOrder(a.order, b.order));
  return {
    conversationId,
    items,
    diagnostics,
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
}

export function projectSession(original: SessionSlice): SessionProjection {
  const slice = reconcileLive(original);
  const records = slice.records.filter(
    (record) => record.sessionId === slice.sessionId && record.conversationId === slice.conversationId,
  );
  const diagnostics: ProjectionIssue[] = [...slice.diagnostics];
  for (const record of slice.records) {
    if (record.sessionId !== slice.sessionId || record.conversationId !== slice.conversationId) {
      diagnostics.push({
        code: "foreign-session",
        message: "Record does not belong to this session",
        sessionId: slice.sessionId,
        recordId: record.recordId,
      });
    }
  }
  const reduced = reduceEngineState(records);
  for (const issue of reduced.issues) {
    diagnostics.push({
      code: `engine-state:${issue.code}`,
      message: issue.message,
      sessionId: slice.sessionId,
      recordId: issue.recordId,
    });
  }

  const items: ConversationViewItem[] = [];
  if (slice.ordinal > 0) {
    items.push({
      kind: "session-boundary",
      key: `sb:${slice.sessionId}`,
      sessionId: slice.sessionId,
      order: [slice.ordinal, 1, -1],
      ...(slice.provider === undefined ? {} : { provider: slice.provider }),
      ...(slice.model === undefined ? {} : { model: slice.model }),
      message: "New session — earlier model context is not carried over.",
    });
  }

  const acceptedTurns = new Set<TurnId>();
  const durableMessages = new Set<StepId>();
  const toolRequests = new Map<ToolCallId, ToolRequest>();
  const toolResults = new Map<ToolCallId, ToolResult>();
  const approvalRequests = new Map<ToolCallId, ApprovalRequest>();
  const approvalResolutions = new Map<ToolCallId, ApprovalResolution>();
  const terminalTurns = new Map<TurnId, TurnStatusItem>();

  for (const record of records) {
    switch (record.type) {
      case Durable.UserInputAccepted: {
        acceptedTurns.add(record.turnId);
        const item: UserMessageItem = {
          kind: "user-message",
          key: `u:${record.turnId}`,
          sessionId: slice.sessionId,
          order: [slice.ordinal, record.sequence, 0],
          turnId: record.turnId,
          text: record.payload.text,
          source: "durable",
        };
        if (!items.some((held) => held.key === item.key)) items.push(item);
        break;
      }
      case Durable.AssistantMessageCompleted: {
        if (record.stepId === undefined) {
          diagnostics.push({
            code: "missing-step-id",
            message: "Assistant message has no provider step identity",
            sessionId: slice.sessionId,
            recordId: record.recordId,
          });
          break;
        }
        durableMessages.add(record.stepId);
        const item: AssistantMessageItem = {
          kind: "assistant-message",
          key: `a:${record.stepId}`,
          sessionId: slice.sessionId,
          order: [slice.ordinal, record.sequence, 0],
          turnId: record.turnId,
          stepId: record.stepId,
          text: record.payload.content,
          source: "durable",
          streaming: false,
        };
        if (!items.some((held) => held.key === item.key)) items.push(item);
        break;
      }
      case Durable.ToolRequested:
        toolRequests.set(record.toolCallId, record);
        break;
      case Durable.ToolResultCompleted:
      case Durable.ToolResultFailed:
      case Durable.ToolResultDenied:
      case Durable.ToolResultAborted:
        toolResults.set(record.toolCallId, record);
        break;
      case Durable.ApprovalRequested:
        approvalRequests.set(record.toolCallId, record);
        break;
      case Durable.ApprovalResolved:
        approvalResolutions.set(record.toolCallId, record);
        break;
      case Durable.TurnCompleted:
      case Durable.TurnFailed:
      case Durable.TurnAborted:
        if (!terminalTurns.has(record.turnId)) {
          const item = turnStatusItem(slice, record);
          terminalTurns.set(record.turnId, item);
          items.push(item);
        }
        break;
      default:
        break;
    }
  }

  if (slice.optimistic !== undefined && !acceptedTurns.has(slice.optimistic.turnId)) {
    items.push({
      kind: "user-message",
      key: `u:${slice.optimistic.turnId}`,
      sessionId: slice.sessionId,
      order: [slice.ordinal, slice.lastSequence + 1, 0],
      turnId: slice.optimistic.turnId,
      text: slice.optimistic.text,
      source: "optimistic",
    });
  }

  const liveText = new Map<StepId, { turnId: TurnId; text: string; tiebreak: number }>();
  for (const [index, event] of slice.live.entries()) {
    if (event.type !== Live.ContentDelta || event.stepId === undefined || event.turnId === undefined) continue;
    if (durableMessages.has(event.stepId)) continue;
    const current = liveText.get(event.stepId);
    liveText.set(event.stepId, {
      turnId: event.turnId,
      text: `${current?.text ?? ""}${event.payload.text}`,
      tiebreak: current?.tiebreak ?? index + 1,
    });
  }
  for (const [stepId, value] of liveText) {
    items.push({
      kind: "assistant-message",
      key: `a:${stepId}`,
      sessionId: slice.sessionId,
      order: [slice.ordinal, slice.lastSequence + 1, value.tiebreak],
      turnId: value.turnId,
      stepId,
      text: value.text,
      source: "live",
      streaming: true,
    });
  }

  const grouped = new Map<StepId, ToolRequest[]>();
  for (const request of toolRequests.values()) {
    const calls = grouped.get(request.stepId) ?? [];
    calls.push(request);
    grouped.set(request.stepId, calls);
  }
  let pendingApproval: ApprovalRequestItem | undefined;
  for (const [stepId, requests] of grouped) {
    const [firstRequest] = requests;
    if (firstRequest === undefined) continue;
    requests.sort((a, b) => a.payload.providerOrder - b.payload.providerOrder || a.sequence - b.sequence);
    const pairs = requests.map((request) => ({
      request,
      call: toolCallView(
        slice.live,
        request,
        toolResults.get(request.toolCallId),
        approvalRequests.get(request.toolCallId),
        approvalResolutions.get(request.toolCallId),
        terminalTurns.has(request.turnId),
      ),
    }));
    const calls = pairs.map((pair) => pair.call);
    const [firstCall] = calls;
    const item: ToolActivityGroupItem = {
      kind: "tool-activity",
      key: `t:${stepId}`,
      sessionId: slice.sessionId,
      order: [slice.ordinal, Math.min(...requests.map((request) => request.sequence)), 0],
      turnId: firstRequest.turnId,
      stepId,
      summary: calls.length === 1 && firstCall !== undefined ? firstCall.headline : `${calls.length} tool calls`,
      status: groupStatus(calls),
      calls,
    };
    items.push(item);
    for (const { request, call } of pairs) {
      const approval = approvalRequests.get(call.toolCallId);
      if (approval === undefined || call.approval?.status !== "pending") continue;
      const approvalItem: ApprovalRequestItem = {
        kind: "approval-request",
        key: `ap:${approval.approvalId}`,
        sessionId: slice.sessionId,
        order: [slice.ordinal, approval.sequence, 0],
        turnId: request.turnId,
        stepId,
        toolCallId: call.toolCallId,
        approvalId: approval.approvalId,
        reason: approval.payload.reason,
        tool: call,
      };
      items.push(approvalItem);
      pendingApproval = approvalItem;
    }
  }

  const running = [...reduced.turns.values()].filter((turn) => turn.status === "running");
  const current = running.at(-1);
  const activeTurn =
    current === undefined
      ? undefined
      : {
          turnId: current.turnId,
          phase: turnPhase(current.turnId, records, slice.live, pendingApproval),
          canStop: true,
        };
  return {
    items,
    diagnostics,
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
}

function turnStatusItem(
  slice: SessionSlice,
  record: DurableRecord<Durable.TurnCompleted | Durable.TurnFailed | Durable.TurnAborted>,
): TurnStatusItem {
  const base = {
    kind: "turn-status" as const,
    key: `st:${record.turnId}`,
    sessionId: slice.sessionId,
    order: [slice.ordinal, record.sequence, 0] as OrderKey,
    turnId: record.turnId,
  };
  switch (record.type) {
    case Durable.TurnCompleted:
      return {
        ...base,
        status: "completed",
        ...(record.payload.stopReason === undefined ? {} : { stopReason: record.payload.stopReason }),
      };
    case Durable.TurnFailed:
      return { ...base, status: "failed", error: record.payload.error };
    case Durable.TurnAborted:
      return {
        ...base,
        status: "aborted",
        ...(record.payload.reason === undefined ? {} : { reason: record.payload.reason }),
      };
  }
}

function toolCallView(
  live: readonly LiveEvent[],
  request: ToolRequest,
  result: ToolResult | undefined,
  approval: ApprovalRequest | undefined,
  resolution: ApprovalResolution | undefined,
  turnTerminal: boolean,
): ToolCallView {
  const relevant = live.filter((event) => event.toolCallId === request.toolCallId);
  const started = relevant.some((event) => event.type === Live.ToolStarted);
  const status = toolStatus(result, approval, resolution, started, turnTerminal);
  const approvalView = approval === undefined ? undefined : approvalStatus(approval, resolution, turnTerminal);
  const error = result !== undefined && result.type !== Durable.ToolResultCompleted ? result.payload.error : undefined;
  const output = result?.type === Durable.ToolResultCompleted ? result.payload.output : undefined;
  const progress = relevant.filter((event) => event.type === Live.ToolProgress).map((event) => event.payload.message);
  const streamedOutput = relevant
    .filter((event) => event.type === Live.StdoutDelta || event.type === Live.StderrDelta)
    .map((event) => event.payload.text)
    .join("");
  const durationMs = result === undefined ? undefined : Date.parse(result.createdAt) - Date.parse(request.createdAt);
  return {
    toolCallId: request.toolCallId,
    name: request.payload.name,
    input: request.payload.input,
    status,
    headline: request.payload.name,
    detail: { presentation: "json", value: output === undefined ? request.payload.input : output },
    requiresApproval: request.payload.requiresApproval,
    ...(approvalView === undefined ? {} : { approval: approvalView }),
    ...(error === undefined ? {} : { error }),
    ...(result?.type === Durable.ToolResultCompleted || result?.type === Durable.ToolResultFailed
      ? result.payload.cancellation === undefined
        ? {}
        : { cancellation: result.payload.cancellation }
      : {}),
    synthetic: result !== undefined && "synthetic" in result.payload && result.payload.synthetic === true,
    ...(durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0 ? {} : { durationMs }),
    progress,
    ...(streamedOutput.length === 0 ? {} : { streamedOutput }),
  };
}

function approvalStatus(
  request: ApprovalRequest,
  resolution: ApprovalResolution | undefined,
  turnTerminal: boolean,
): ApprovalView {
  if (resolution !== undefined) {
    return {
      approvalId: request.approvalId,
      reason: request.payload.reason,
      status: resolution.payload.decision === ApprovalDecisions.Allow ? "allowed" : "denied",
      decision: resolution.payload.decision,
    };
  }
  return {
    approvalId: request.approvalId,
    reason: request.payload.reason,
    status: turnTerminal ? "cancelled" : "pending",
  };
}

function toolStatus(
  result: ToolResult | undefined,
  approval: ApprovalRequest | undefined,
  resolution: ApprovalResolution | undefined,
  started: boolean,
  turnTerminal: boolean,
): ToolCallStatus {
  switch (result?.type) {
    case Durable.ToolResultCompleted:
      return "completed";
    case Durable.ToolResultFailed:
      return "failed";
    case Durable.ToolResultDenied:
      return "denied";
    case Durable.ToolResultAborted:
      return "aborted";
  }
  if (turnTerminal) return "aborted";
  if (approval !== undefined && resolution === undefined) return "awaiting-approval";
  return started || resolution?.payload.decision === ApprovalDecisions.Allow ? "running" : "requested";
}

function groupStatus(calls: readonly ToolCallView[]): ToolGroupStatus {
  if (calls.some((call) => call.status === "awaiting-approval")) return "awaiting-approval";
  if (calls.some((call) => call.status === "requested" || call.status === "running")) return "running";
  if (calls.every((call) => call.status === "completed")) return "completed";
  if (calls.some((call) => call.status === "completed")) return "partial-failure";
  if (calls.every((call) => call.status === "denied")) return "denied";
  if (calls.every((call) => call.status === "aborted")) return "aborted";
  return "failed";
}

function turnPhase(
  turnId: TurnId,
  records: readonly DurableRecord[],
  live: readonly LiveEvent[],
  pendingApproval: ApprovalRequestItem | undefined,
): TurnPhase {
  if (pendingApproval?.turnId === turnId) return "awaiting-approval";
  const requested = records.filter(
    (record): record is ToolRequest => record.type === Durable.ToolRequested && record.turnId === turnId,
  );
  const terminalTools = new Set(
    records
      .filter(
        (record): record is ToolResult =>
          record.type === Durable.ToolResultCompleted ||
          record.type === Durable.ToolResultFailed ||
          record.type === Durable.ToolResultDenied ||
          record.type === Durable.ToolResultAborted,
      )
      .map((record) => record.toolCallId),
  );
  if (requested.some((record) => !terminalTools.has(record.toolCallId))) return "executing-tools";
  const lastStep = records
    .filter((record) => record.type === Durable.ProviderStepStarted && record.turnId === turnId)
    .at(-1);
  if (lastStep === undefined) return "waiting-for-model";
  const stepFinished = records.some(
    (record) =>
      (record.type === Durable.ProviderStepCompleted || record.type === Durable.ProviderStepFailed) &&
      record.stepId === lastStep.stepId,
  );
  if (stepFinished) return "finishing";
  return live.some((event) => event.type === Live.ContentDelta && event.stepId === lastStep.stepId)
    ? "generating"
    : "waiting-for-model";
}

function compareOrder(a: OrderKey, b: OrderKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
