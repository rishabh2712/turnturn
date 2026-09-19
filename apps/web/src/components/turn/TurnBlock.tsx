import type {
  ApprovalRequestItem,
  ToolActionPresentation,
  TraceSelection,
  TurnPresentation,
} from "@turnturn/chat-client";
import type { ApprovalDecisions, ConversationId } from "@turnturn/protocol";
import { ApprovalCard } from "../approval/ApprovalCard";
import { ToolActionCard } from "../tool/ToolActionCard";

export function TurnBlock({
  turn,
  conversationId,
  onInspect,
  onResolveApproval,
}: {
  readonly turn: TurnPresentation;
  readonly conversationId: ConversationId;
  readonly onInspect: (selection: TraceSelection) => void;
  readonly onResolveApproval: (
    item: ApprovalRequestItem,
    decision: ApprovalDecisions,
  ) => Promise<"accepted" | "cancelled">;
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
                  onResolve={(decision) =>
                    onResolveApproval(approvalFor(step.actions) as ApprovalRequestItem, decision)
                  }
                />
              )}
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
            {turn.finalResponse.text}
            {turn.finalResponse.streaming ? <span className="tt-cursor">▋</span> : null}
          </div>
        </div>
      )}
      {turn.outcome !== undefined && turn.outcome.status !== "completed" ? (
        <div className="tt-status-line">
          Turn {turn.outcome.status}: {turn.outcome.error?.message ?? turn.outcome.reason}
        </div>
      ) : null}
    </article>
  );
}

function approvalFor(actions: readonly ToolActionPresentation[]): ApprovalRequestItem | undefined {
  return actions.find((action) => action.approval !== undefined)?.approval;
}
