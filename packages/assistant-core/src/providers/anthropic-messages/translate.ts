import type { JsonValue } from "@turnturn/protocol";
import type { CompletionReason, ProviderEvent, ProviderUsage } from "../../ports.js";

export interface AnthropicTranslationState {
  readonly blocks: Map<number, ContentBlockState>;
  pendingCompletion?: CompletionReason;
  usage?: ProviderUsage;
  responseId?: string;
  toolCalls: number;
  completedToolCalls: number;
  done: boolean;
}

interface ContentBlockState {
  readonly type: string;
  readonly callId?: string;
  readonly name?: string;
  initialInput?: JsonValue;
  argumentsJson: string;
}

export function createAnthropicTranslationState(): AnthropicTranslationState {
  return { blocks: new Map(), toolCalls: 0, completedToolCalls: 0, done: false };
}

export function translateAnthropicFrame(
  eventName: string | undefined,
  data: string,
  state: AnthropicTranslationState,
): ProviderEvent[] {
  if (state.done) return [];
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return fail(state, "Anthropic SSE data was not valid JSON");
  }
  if (!isRecord(frame)) return fail(state, "Anthropic SSE data was not an object");
  const type = stringField(frame, "type") ?? eventName;
  if (eventName !== undefined && stringField(frame, "type") !== undefined && eventName !== frame.type) {
    return fail(state, `Anthropic SSE event ${eventName} disagreed with data type ${String(frame.type)}`);
  }

  switch (type) {
    case "ping":
      return [];
    case "message_start":
      return translateMessageStart(frame, state);
    case "content_block_start":
      return translateContentBlockStart(frame, state);
    case "content_block_delta":
      return translateContentBlockDelta(frame, state);
    case "content_block_stop":
      return translateContentBlockStop(frame, state);
    case "message_delta":
      return translateMessageDelta(frame, state);
    case "message_stop":
      return translateMessageStop(state);
    case "error":
      return translateError(frame, state);
    default:
      return fail(state, `Unrecognised Anthropic SSE event: ${String(type)}`);
  }
}

export function translateAnthropicStreamEnd(state: AnthropicTranslationState): ProviderEvent[] {
  if (state.done) return [];
  state.done = true;
  return [
    {
      type: "failed",
      error: { kind: "interrupted", message: "Anthropic SSE stream ended before message_stop", retryable: true },
    },
  ];
}

function translateMessageStart(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const message = objectField(frame, "message");
  if (message === undefined) return fail(state, "Anthropic message_start did not include a message");
  const responseId = stringField(message, "id");
  if (responseId !== undefined) state.responseId = responseId;
  const usage = anthropicUsage(objectField(message, "usage"));
  if (usage === undefined) return [];
  state.usage = mergeUsage(state.usage, usage);
  return [{ type: "usage", usage }];
}

function translateContentBlockStart(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const index = numberField(frame, "index");
  const block = objectField(frame, "content_block");
  if (index === undefined || block === undefined) return fail(state, "Invalid Anthropic content_block_start");
  if (state.blocks.has(index)) return fail(state, `Anthropic content block ${index} started more than once`);
  const type = stringField(block, "type");
  if (type === undefined) return fail(state, `Anthropic content block ${index} had no type`);
  if (type === "tool_use") {
    const callId = stringField(block, "id");
    const name = stringField(block, "name");
    if (callId === undefined || name === undefined) return fail(state, "Anthropic tool_use block omitted id or name");
    state.blocks.set(index, {
      type,
      callId,
      name,
      ...(Object.hasOwn(block, "input") ? { initialInput: block.input as JsonValue } : {}),
      argumentsJson: "",
    });
    state.toolCalls += 1;
    return [{ type: "tool-call-start", callId, name }];
  }
  state.blocks.set(index, { type, argumentsJson: "" });
  return [];
}

function translateContentBlockDelta(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const index = numberField(frame, "index");
  const delta = objectField(frame, "delta");
  if (index === undefined || delta === undefined) return fail(state, "Invalid Anthropic content_block_delta");
  const block = state.blocks.get(index);
  if (block === undefined) return fail(state, `Anthropic delta referenced content block ${index} before it started`);
  const type = stringField(delta, "type");
  switch (type) {
    case "text_delta": {
      const text = stringField(delta, "text");
      return text === undefined || text.length === 0 ? [] : [{ type: "text-delta", text }];
    }
    case "thinking_delta": {
      const text = stringField(delta, "thinking");
      return text === undefined || text.length === 0 ? [] : [{ type: "reasoning-delta", text }];
    }
    case "input_json_delta": {
      if (block.type !== "tool_use" || block.callId === undefined)
        return fail(state, "Anthropic input_json_delta targeted a non-tool block");
      const text = stringField(delta, "partial_json");
      if (text === undefined || text.length === 0) return [];
      block.argumentsJson += text;
      return [{ type: "tool-call-arguments-delta", callId: block.callId, text }];
    }
    case "signature_delta":
      return [];
    default:
      return fail(state, `Unrecognised Anthropic content delta: ${String(type)}`);
  }
}

function translateContentBlockStop(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const index = numberField(frame, "index");
  if (index === undefined) return fail(state, "Anthropic content_block_stop omitted index");
  const block = state.blocks.get(index);
  if (block === undefined) return fail(state, `Anthropic content block ${index} stopped before it started`);
  state.blocks.delete(index);
  if (block.type !== "tool_use") return [];
  if (block.callId === undefined || block.name === undefined)
    return fail(state, "Anthropic tool block omitted identity");
  let input: JsonValue;
  try {
    input =
      block.argumentsJson.length === 0 ? (block.initialInput ?? {}) : (JSON.parse(block.argumentsJson) as JsonValue);
  } catch {
    return fail(state, `Anthropic tool call ${block.callId} ended with invalid JSON arguments`);
  }
  state.completedToolCalls += 1;
  return [{ type: "tool-call-complete", call: { callId: block.callId, name: block.name, input } }];
}

function translateMessageDelta(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const usage = anthropicUsage(objectField(frame, "usage"));
  if (usage !== undefined) {
    state.usage = mergeUsage(state.usage, usage);
    events.push({ type: "usage", usage });
  }
  const delta = objectField(frame, "delta");
  const stopReason = delta === undefined ? undefined : stringField(delta, "stop_reason");
  if (stopReason === undefined) return events;
  const reason = mapAnthropicStopReason(stopReason);
  if (reason === undefined) return [...events, ...fail(state, `Unrecognised Anthropic stop_reason: ${stopReason}`)];
  if (state.blocks.size > 0) return [...events, ...fail(state, "Anthropic message finished with open content blocks")];
  if (reason === "tool-use" && state.toolCalls === 0)
    return [...events, ...fail(state, "Anthropic tool_use stop_reason arrived without tool calls")];
  if (reason !== "tool-use" && state.toolCalls > 0)
    return [...events, ...fail(state, `Anthropic ${stopReason} stop_reason arrived with tool calls`)];
  if (state.completedToolCalls !== state.toolCalls)
    return [...events, ...fail(state, "Anthropic message finished before every tool call completed")];
  state.pendingCompletion = reason;
  return events;
}

function translateMessageStop(state: AnthropicTranslationState): ProviderEvent[] {
  if (state.pendingCompletion === undefined) return fail(state, "Anthropic message_stop arrived without a stop_reason");
  state.done = true;
  return [
    {
      type: "completed",
      reason: state.pendingCompletion,
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    },
  ];
}

function translateError(frame: Record<string, unknown>, state: AnthropicTranslationState): ProviderEvent[] {
  const error = objectField(frame, "error");
  const type = error === undefined ? undefined : stringField(error, "type");
  const message = error === undefined ? undefined : stringField(error, "message");
  state.done = true;
  return [
    {
      type: "failed",
      error: {
        kind: type === "invalid_request_error" ? "request-rejected" : "transport",
        message: message ?? "Anthropic stream returned an error",
        retryable: type === "overloaded_error" || type === "rate_limit_error" || type === "api_error",
      },
    },
  ];
}

export function mapAnthropicStopReason(reason: string): CompletionReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "complete";
    case "tool_use":
      return "tool-use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "output-limit";
    case "refusal":
      return "refused";
    default:
      return undefined;
  }
}

function anthropicUsage(value: Record<string, unknown> | undefined): ProviderUsage | undefined {
  if (value === undefined) return undefined;
  const inputTokens = numberField(value, "input_tokens");
  const outputTokens = numberField(value, "output_tokens");
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function mergeUsage(current: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  const inputTokens = next.inputTokens ?? current?.inputTokens;
  const outputTokens = next.outputTokens ?? current?.outputTokens;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
  };
}

function fail(state: AnthropicTranslationState, message: string): ProviderEvent[] {
  state.done = true;
  return [{ type: "failed", error: { kind: "protocol", message, retryable: false } }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}
