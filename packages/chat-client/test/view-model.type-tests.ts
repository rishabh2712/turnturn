import type { ConversationViewItem } from "../src/view-model.js";

function assertNever(value: never): never {
  throw new Error(`Unexpected conversation item: ${String(value)}`);
}

export function labelForItem(item: ConversationViewItem): string {
  switch (item.kind) {
    case "user-message":
      return "user";
    case "assistant-message":
      return "assistant";
    case "tool-activity":
      return "tools";
    case "approval-request":
      return "approval";
    case "turn-status":
      return "turn";
    case "session-boundary":
      return "session";
    default:
      return assertNever(item);
  }
}
