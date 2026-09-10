import {
  ApprovalDecisions,
  type ApprovalId,
  type ConversationId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@turnturn/protocol";

export interface PendingApproval {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly approvalId: ApprovalId;
  resolve(decision: ApprovalDecisions): void;
}

export class ApprovalRegistry {
  private readonly pending = new Map<ApprovalId, PendingApproval>();

  wait(pending: Omit<PendingApproval, "resolve">, signal: AbortSignal): Promise<ApprovalDecisions> {
    return new Promise<ApprovalDecisions>((resolve) => {
      this.pending.set(pending.approvalId, { ...pending, resolve });
      if (signal.aborted) {
        this.pending.delete(pending.approvalId);
        resolve(ApprovalDecisions.Deny);
      }
    });
  }

  take(approvalId: ApprovalId): PendingApproval | undefined {
    const pending = this.pending.get(approvalId);
    if (pending === undefined) return undefined;
    this.pending.delete(approvalId);
    return pending;
  }

  complete(pending: PendingApproval, decision: ApprovalDecisions): void {
    pending.resolve(decision);
  }

  cancelTurn(turnId: TurnId): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.turnId === turnId) {
        this.pending.delete(approvalId);
        pending.resolve(ApprovalDecisions.Deny);
      }
    }
  }
}
