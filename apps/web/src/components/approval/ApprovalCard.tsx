import type { ApprovalRequestItem } from "@turnturn/chat-client";
import { ApprovalDecisions } from "@turnturn/protocol";

export type ApprovalCommandStatus = "pending" | "resolving" | "stale" | "error";

interface ApprovalCardProps {
  readonly item: ApprovalRequestItem;
  readonly status: ApprovalCommandStatus;
  readonly error?: string;
  readonly onResolve: (decision: ApprovalDecisions) => Promise<void>;
}

export function ApprovalCard({ item, status, error, onResolve }: ApprovalCardProps) {
  return (
    <section className="tt-approval-card" aria-label={`Approval needed for ${item.tool.name}`}>
      <div className="tt-approval-heading">Approval needed · {item.tool.name}</div>
      <p>{item.reason}</p>
      <ApprovalDetails item={item} />
      <ApprovalControls status={status} error={error} onResolve={onResolve} />
    </section>
  );
}

export function ApprovalDetails({ item }: { readonly item: ApprovalRequestItem }) {
  const shell = item.tool.detail.presentation === "shell" ? item.tool.detail : undefined;
  return shell === undefined ? (
    <pre className="tt-approval-command">{JSON.stringify(item.tool.input, null, 2)}</pre>
  ) : (
    <>
      <pre className="tt-approval-command">{shell.command}</pre>
      {shell.cwd !== undefined ? <div className="tt-approval-cwd">Working directory: {shell.cwd}</div> : null}
    </>
  );
}

export function ApprovalControls({ status, error, onResolve }: Omit<ApprovalCardProps, "item">) {
  return (
    <>
      {status === "stale" ? (
        <output>This approval is no longer pending on the server; its recorded outcome is not yet available.</output>
      ) : null}
      {status === "resolving" ? <output>Resolving…</output> : null}
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {status !== "stale" ? (
        <div className="tt-approval-actions">
          <button
            type="button"
            disabled={status === "resolving"}
            onClick={() => void onResolve(ApprovalDecisions.Deny)}
          >
            Deny
          </button>
          <button
            type="button"
            disabled={status === "resolving"}
            onClick={() => void onResolve(ApprovalDecisions.Allow)}
          >
            Allow
          </button>
        </div>
      ) : null}
    </>
  );
}
