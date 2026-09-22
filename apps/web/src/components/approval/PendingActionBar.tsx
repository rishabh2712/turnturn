import type { ApprovalRequestItem } from "@turnturn/chat-client";
import type { ApprovalDecisions } from "@turnturn/protocol";
import { type ApprovalCommandStatus, ApprovalControls, ApprovalDetails } from "./ApprovalCard";

export function PendingActionBar({
  item,
  status,
  error,
  onResolve,
}: {
  readonly item: ApprovalRequestItem;
  readonly status: ApprovalCommandStatus;
  readonly error?: string;
  readonly onResolve: (decision: ApprovalDecisions) => Promise<void>;
}) {
  return (
    <section className="tt-pending-action" aria-label="Pending action">
      <div className="tt-pending-action-heading">Approval needed · {item.tool.name}</div>
      <p>{item.reason}</p>
      <details>
        <summary>Review exact action</summary>
        <ApprovalDetails item={item} />
      </details>
      <ApprovalControls status={status} error={error} onResolve={onResolve} />
    </section>
  );
}
