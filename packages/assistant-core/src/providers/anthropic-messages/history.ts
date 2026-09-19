import type { JsonValue } from "@turnturn/protocol";
import { ProviderHistoryItemTypes, ProviderToolResultStatuses } from "@turnturn/protocol/provider-history";
import type { ProviderRequest } from "../../ports.js";

export function providerHistoryToAnthropicMessages(items: ProviderRequest["history"]["items"]): JsonValue[] {
  const messages: JsonValue[] = [];
  const providerCallIds = new Map<string, string>();
  let assistant: AnthropicContentBlock[] = [];
  let toolResults: AnthropicContentBlock[] = [];

  const flushAssistant = () => {
    if (assistant.length === 0) return;
    messages.push({ role: "assistant", content: assistant });
    assistant = [];
  };
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };

  for (const item of items) {
    switch (item.type) {
      case ProviderHistoryItemTypes.UserInput:
        flushAssistant();
        flushToolResults();
        messages.push({ role: "user", content: item.content });
        break;
      case ProviderHistoryItemTypes.AssistantMessage:
        flushToolResults();
        assistant.push({ type: "text", text: item.content });
        break;
      case ProviderHistoryItemTypes.ToolRequest: {
        flushToolResults();
        const providerCallId = item.providerToolCallId ?? item.toolCallId;
        providerCallIds.set(item.toolCallId, providerCallId);
        assistant.push({ type: "tool_use", id: providerCallId, name: item.name, input: item.input });
        break;
      }
      case ProviderHistoryItemTypes.ToolResult:
        flushAssistant();
        toolResults.push({
          type: "tool_result",
          tool_use_id: providerCallIds.get(item.toolCallId) ?? item.toolCallId,
          content: stringifyToolResult(item),
          ...(item.status === ProviderToolResultStatuses.Completed ? {} : { is_error: true }),
        });
        break;
      default:
        assertNever(item);
    }
  }

  flushAssistant();
  flushToolResults();
  return messages;
}

type AnthropicContentBlock = Record<string, JsonValue>;

function stringifyToolResult(
  item: Extract<ProviderRequest["history"]["items"][number], { readonly type: ProviderHistoryItemTypes.ToolResult }>,
): string {
  if (Object.hasOwn(item, "output")) return JSON.stringify(item.output);
  if (item.error !== undefined) return JSON.stringify(item.error);
  return JSON.stringify({ status: item.status });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled provider history item: ${JSON.stringify(value)}`);
}
