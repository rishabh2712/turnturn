import type { ProviderEvent } from "../src/ports.js";

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
