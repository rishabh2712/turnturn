import type { ApprovalRequestItem } from "@turnturn/chat-client";
import { ApprovalDecisions } from "@turnturn/protocol";
import { useRef, useState } from "react";

interface ApprovalCardProps {
  readonly item: ApprovalRequestItem;
  readonly onResolve: (decision: ApprovalDecisions) => Promise<"accepted" | "cancelled">;
}

export function ApprovalCard({ item, onResolve }: ApprovalCardProps) {
  const inFlight = useRef(false);
  const [state, setState] = useState<"pending" | "resolving" | "cancelled">("pending");
  const [error, setError] = useState<string | undefined>();
  const shell = item.tool.detail.presentation === "shell" ? item.tool.detail : undefined;

  async function choose(decision: ApprovalDecisions) {
    if (inFlight.current || state !== "pending") return;
    inFlight.current = true;
    setState("resolving");
    setError(undefined);
    try {
      const outcome = await onResolve(decision);
      if (outcome === "cancelled") setState("cancelled");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("pending");
      inFlight.current = false;
    }
  }

  return (
    <section className="tt-approval-card" aria-label={`Approval needed for ${item.tool.name}`}>
      <div className="tt-approval-heading">Approval needed · {item.tool.name}</div>
      <p>{item.reason}</p>
      {shell === undefined ? (
        <pre className="tt-approval-command">{JSON.stringify(item.tool.input, null, 2)}</pre>
      ) : (
        <>
          <pre className="tt-approval-command">{shell.command}</pre>
          {shell.cwd !== undefined ? <div className="tt-approval-cwd">Working directory: {shell.cwd}</div> : null}
        </>
      )}
      {state === "cancelled" ? <output>This approval is no longer pending.</output> : null}
      {state === "resolving" ? <output>Resolving…</output> : null}
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {state !== "cancelled" ? (
        <div className="tt-approval-actions">
          <button type="button" disabled={state === "resolving"} onClick={() => void choose(ApprovalDecisions.Deny)}>
            Deny
          </button>
          <button type="button" disabled={state === "resolving"} onClick={() => void choose(ApprovalDecisions.Allow)}>
            Allow
          </button>
        </div>
      ) : null}
    </section>
  );
}
