import type { ContextSelection } from "../src/context/index.js";
import type { ProviderEvent } from "../src/ports.js";

export function exhaustiveContextSelection(selection: ContextSelection): string {
  switch (selection.disposition) {
    case "included":
      return `${selection.order}:${selection.contributionId}`;
    case "excluded":
      return `${selection.contributionId}:${selection.reason}`;
    case "unavailable":
      return `${selection.kind}:${selection.reason}`;
    default: {
      const neverSelection: never = selection;
      return neverSelection;
    }
  }
}

export function exhaustiveProviderEvent(event: ProviderEvent): string {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta":
      return event.text;
    case "tool-call-start":
      return event.name;
    case "tool-call-arguments-delta":
      return event.callId;
    case "tool-call-complete":
      return event.call.name;
    case "usage":
      return String(event.usage.totalTokens ?? 0);
    case "completed":
      return event.reason;
    case "failed":
      return event.error.kind;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}
