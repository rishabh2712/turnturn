import type { JsonValue } from "@turnturn/protocol";
import { ProviderHistoryItemTypes } from "@turnturn/protocol/provider-history";
import type { ProviderRequest } from "../../ports.js";

export function providerHistoryToChatMessages(items: ProviderRequest["history"]["items"]): JsonValue[] {
  const messages: JsonValue[] = [];
  let pendingAssistant: PendingAssistant | undefined;

  const flushAssistant = () => {
    if (pendingAssistant === undefined) return;
    if (pendingAssistant.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: pendingAssistant.content ?? null,
        tool_calls: pendingAssistant.toolCalls,
      });
    } else if (pendingAssistant.content !== undefined) {
      messages.push({ role: "assistant", content: pendingAssistant.content });
    }
    pendingAssistant = undefined;
  };

  for (const item of items) {
    switch (item.type) {
      case ProviderHistoryItemTypes.UserInput:
        flushAssistant();
        messages.push({ role: "user", content: item.content });
        break;
      case ProviderHistoryItemTypes.AssistantMessage:
        flushAssistant();
        pendingAssistant = { content: item.content, toolCalls: [] };
        break;
      case ProviderHistoryItemTypes.ToolRequest:
        pendingAssistant ??= { toolCalls: [] };
        pendingAssistant.toolCalls.push({
          id: item.providerToolCallId ?? item.toolCallId,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.input) },
        });
        break;
      case ProviderHistoryItemTypes.ToolResult:
        flushAssistant();
        messages.push({
          role: "tool",
          tool_call_id: item.toolCallId,
          content: stringifyToolResultContent(item),
        });
        break;
      default:
        assertNeverHistoryItem(item);
    }
  }

  flushAssistant();
  return messages;
}

interface PendingAssistant {
  content?: string;
  readonly toolCalls: JsonValue[];
}

function stringifyToolResultContent(
  item: Extract<ProviderRequest["history"]["items"][number], { readonly type: ProviderHistoryItemTypes.ToolResult }>,
): string {
  if (Object.hasOwn(item, "output")) return JSON.stringify(item.output);
  if (item.error !== undefined) return JSON.stringify(item.error);
  return JSON.stringify({ status: item.status });
}

function assertNeverHistoryItem(value: never): never {
  throw new Error(`Unhandled provider history item: ${JSON.stringify(value)}`);
}
