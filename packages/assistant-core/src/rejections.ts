import type { CommandOutcome } from "./ports.js";

export const commandRejected = {
  approvalNotPending(): CommandOutcome {
    return rejected("APPROVAL_NOT_PENDING", "Approval is not pending");
  },
  toolCancelUnsupported(): CommandOutcome {
    return rejected("UNIMPLEMENTED", "tool.cancel is not implemented yet");
  },
  turnNotRunning(): CommandOutcome {
    return rejected("TURN_NOT_RUNNING", "Turn is not running");
  },
};

function rejected(code: string, message: string): CommandOutcome {
  return { kind: "rejected", code, message };
}
