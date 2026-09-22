import type {
  ApprovalRequestItem,
  ApprovalView,
  ToolActionPresentation,
  TraceSelection,
  TurnPresentation,
} from "@turnturn/chat-client";
import type { ApprovalDecisions, ConversationId } from "@turnturn/protocol";
import { ApprovalCard, type ApprovalCommandStatus } from "../approval/ApprovalCard";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import { ToolActionCard } from "../tool/ToolActionCard";

export function TurnBlock({
  turn,
  conversationId,
  onInspect,
  onResolveApproval,
  approvalCommand,
  approvalReceipts,
}: {
  readonly turn: TurnPresentation;
  readonly conversationId: ConversationId;
  readonly onInspect: (selection: TraceSelection) => void;
  readonly onResolveApproval: (item: ApprovalRequestItem, decision: ApprovalDecisions) => Promise<void>;
  readonly approvalCommand?: {
    readonly approvalId: string;
    readonly status: ApprovalCommandStatus;
    readonly message?: string;
  };
  readonly approvalReceipts: ReadonlyMap<string, ApprovalView>;
}) {
  return (
    <article className="tt-turn" data-turn-id={turn.turnId}>
      <div className="tt-message tt-user-message">
        <span className="tt-message-label">You</span>
        <div>{turn.user.text}</div>
      </div>
      {turn.steps.length > 0 ? (
        <div className="tt-agent-loop">
          {turn.steps.map((step) => (
            <section className="tt-agent-step" key={step.key}>
              <div className="tt-agent-step-heading">
                <span className="tt-step-dot" aria-hidden="true" />
                <span>{step.summary}</span>
                <small>{step.status.replaceAll("-", " ")}</small>
              </div>
              {step.assistantOutput?.text ? <p className="tt-step-text">{step.assistantOutput.text}</p> : null}
              <div className="tt-action-list">
                {step.actions.map((action) => (
                  <ToolActionCard action={action} key={action.key} />
                ))}
              </div>
              {approvalFor(step.actions) === undefined ? null : (
                <ApprovalCard
                  item={approvalFor(step.actions) as ApprovalRequestItem}
                  status={
                    approvalCommand !== undefined &&
                    approvalCommand.approvalId === approvalFor(step.actions)?.approvalId
                      ? approvalCommand.status
                      : "pending"
                  }
                  error={
                    approvalCommand !== undefined &&
                    approvalCommand.approvalId === approvalFor(step.actions)?.approvalId
                      ? approvalCommand.message
                      : undefined
                  }
                  onResolve={(decision) =>
                    onResolveApproval(approvalFor(step.actions) as ApprovalRequestItem, decision)
                  }
                />
              )}
              {step.actions.map((action) => {
                const receipt = approvalReceipts.get(action.toolCallId);
                if (receipt === undefined) return null;
                return (
                  <output className="tt-approval-receipt" key={receipt.approvalId}>
                    {receipt.status === "allowed"
                      ? "Allowed"
                      : receipt.status === "denied"
                        ? "Denied"
                        : "Approval no longer pending"}
                    <span> · {action.displayName}</span>
                  </output>
                );
              })}
            </section>
          ))}
        </div>
      ) : null}
      {turn.finalResponse === undefined ? null : (
        <div className="tt-message tt-assistant-message">
          <span className="tt-message-label tt-message-label-row">
            Assistant
            {!turn.finalResponse.streaming ? (
              <button
                onClick={() => onInspect({ conversationId, sessionId: turn.sessionId, turnId: turn.turnId })}
                type="button"
              >
                Inspect trace
              </button>
            ) : null}
          </span>
          <div>
            <MarkdownMessage content={turn.finalResponse.text} streaming={turn.finalResponse.streaming} />
            {turn.finalResponse.streaming ? <span className="tt-cursor">▋</span> : null}
          </div>
        </div>
      )}
      {turn.outcome !== undefined && turn.outcome.status !== "completed" ? (
        <div className="tt-status-line">
          {turn.outcome.status === "aborted" && turn.outcome.reason === "Stopped by user"
            ? "Stopped"
            : `Turn ${turn.outcome.status}: ${turn.outcome.error?.message ?? turn.outcome.reason}`}
        </div>
      ) : null}
    </article>
  );
}

function approvalFor(actions: readonly ToolActionPresentation[]): ApprovalRequestItem | undefined {
  return actions.find((action) => action.approval !== undefined)?.approval;
}
