import type { ConversationPresentation, TurnPresentation } from "./presentation-model.js";
import { presentToolCall } from "./tool-presentation.js";
import type {
  ApprovalRequestItem,
  AssistantMessageItem,
  ConversationView,
  ConversationViewItem,
  SessionBoundaryItem,
  ToolActivityGroupItem,
  TurnStatusItem,
  UserMessageItem,
} from "./view-model.js";

interface MutableTurn {
  readonly user: UserMessageItem;
  readonly items: ConversationViewItem[];
}

export function composeConversationPresentation(view: ConversationView): ConversationPresentation {
  const timeline: Array<SessionBoundaryItem | TurnPresentation> = [];
  const turns = new Map<string, MutableTurn>();
  for (const item of view.items) {
    if (item.kind === "session-boundary") {
      timeline.push(item);
      continue;
    }
    if (item.kind === "user-message") {
      const key = turnKey(item.sessionId, item.turnId);
      const turn = { user: item, items: [item] };
      turns.set(key, turn);
      timeline.push(composeTurn(turn));
      continue;
    }
    const key = turnKey(item.sessionId, item.turnId);
    const held = turns.get(key);
    if (held !== undefined) held.items.push(item);
  }
  // Turn objects were inserted before their later items arrived; compose once after grouping.
  const composed = timeline.map((item) => {
    if (item.kind === "session-boundary") return item;
    const turn = turns.get(turnKey(item.sessionId, item.turnId));
    return turn === undefined ? item : composeTurn(turn);
  });
  return {
    conversationId: view.conversationId,
    timeline: composed,
    diagnostics: view.diagnostics,
    ...(view.activeTurn === undefined ? {} : { activeTurn: view.activeTurn }),
    ...(view.pendingApproval === undefined ? {} : { pendingApproval: view.pendingApproval }),
  };
}

function composeTurn(turn: MutableTurn): TurnPresentation {
  const messages = turn.items.filter((item): item is AssistantMessageItem => item.kind === "assistant-message");
  const groups = turn.items.filter((item): item is ToolActivityGroupItem => item.kind === "tool-activity");
  const approvals = turn.items.filter((item): item is ApprovalRequestItem => item.kind === "approval-request");
  const outcome = turn.items.find((item): item is TurnStatusItem => item.kind === "turn-status");
  const toolStepIds = new Set(groups.map((group) => group.stepId));
  const finalResponse = [...messages].reverse().find((message) => !toolStepIds.has(message.stepId));
  const stepIds = new Set([...messages.map((message) => message.stepId), ...groups.map((group) => group.stepId)]);
  const steps = [...stepIds]
    .map((stepId) => {
      const assistantOutput = messages.find((message) => message.stepId === stepId);
      const group = groups.find((candidate) => candidate.stepId === stepId);
      if (assistantOutput === finalResponse && group === undefined) return undefined;
      const actions =
        group?.calls.map((call) =>
          presentToolCall(
            call,
            approvals.find((item) => item.toolCallId === call.toolCallId),
          ),
        ) ?? [];
      const awaitingApproval = actions.some((action) => action.status === "awaiting-approval");
      const failed = actions.some((action) => ["failed", "denied", "aborted"].includes(action.status));
      const streaming = assistantOutput?.streaming === true;
      return {
        key: `step:${stepId}`,
        stepId,
        ordinal: Math.min(
          assistantOutput?.order[1] ?? Number.MAX_SAFE_INTEGER,
          group?.order[1] ?? Number.MAX_SAFE_INTEGER,
        ),
        status: awaitingApproval
          ? ("awaiting-approval" as const)
          : streaming
            ? ("streaming" as const)
            : failed
              ? ("failed" as const)
              : actions.length > 0
                ? ("using-tools" as const)
                : ("completed" as const),
        summary: group?.summary ?? "Assistant step",
        ...(assistantOutput === undefined ? {} : { assistantOutput }),
        actions,
      };
    })
    .filter((step): step is NonNullable<typeof step> => step !== undefined)
    .sort((left, right) => left.ordinal - right.ordinal);
  const blockingApproval = approvals.find((approval) => approval.tool.approval?.status === "pending");
  return {
    kind: "turn",
    key: `turn:${turn.user.sessionId}:${turn.user.turnId}`,
    sessionId: turn.user.sessionId,
    turnId: turn.user.turnId,
    user: turn.user,
    steps,
    ...(finalResponse === undefined ? {} : { finalResponse }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(blockingApproval === undefined ? {} : { blockingApproval }),
  };
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
