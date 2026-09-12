import type { CompletionReason, ProviderEvent, ProviderUsage } from "../../ports.js";
import type { ChatFrame, DoneFrame } from "./frames.js";
import { arrayField, isRecord, numberField, objectField, stringField } from "./frames.js";
import { ChatToolCallAssembler, type ToolCallUpdate } from "./tool-calls.js";

export interface TranslationState {
  readonly toolCalls: ChatToolCallAssembler;
  pendingCompletion?: CompletionReason;
  done: boolean;
}

export function createTranslationState(): TranslationState {
  return { toolCalls: new ChatToolCallAssembler(), done: false };
}

export function translateFrame(frame: ChatFrame | DoneFrame, state: TranslationState): ProviderEvent[] {
  if (state.done) return [];
  if (frame.kind === "done") return translateDone(state);

  const events: ProviderEvent[] = [];
  const usage = extractUsage(frame.value);
  if (usage !== undefined) events.push({ type: "usage", usage });

  const choice = firstChoice(frame.value);
  if (choice === undefined) return events;

  const delta = objectField(choice, "delta");
  if (delta !== undefined) {
    const postFinishFailure = failIfContentArrivedAfterFinish(delta, state);
    if (postFinishFailure !== undefined) return finishWith(events, state, postFinishFailure);

    const content = stringField(delta, "content");
    if (content !== undefined && content.length > 0) events.push({ type: "text-delta", text: content });

    const reasoning = stringField(delta, "reasoning_content");
    if (reasoning !== undefined && reasoning.length > 0) events.push({ type: "reasoning-delta", text: reasoning });

    for (const update of toolCallUpdates(delta)) {
      events.push(...state.toolCalls.merge(update));
    }
  }

  const finishReason = stringField(choice, "finish_reason");
  if (finishReason !== undefined) {
    const finishEvents = applyFinishReason(finishReason, state);
    events.push(...finishEvents);
  }

  return events;
}

export function translateStreamEnd(state: TranslationState): ProviderEvent[] {
  if (state.done) return [];
  if (state.pendingCompletion !== undefined) {
    state.done = true;
    return [{ type: "completed", reason: state.pendingCompletion }];
  }
  state.done = true;
  return [
    {
      type: "failed",
      error: { kind: "interrupted", message: "SSE stream ended before completion", retryable: true },
    },
  ];
}

export function mapFinishReason(reason: string): CompletionReason | undefined {
  switch (reason) {
    case "stop":
      return "complete";
    case "tool_calls":
    case "function_call":
      return "tool-use";
    case "length":
      return "output-limit";
    case "content_filter":
      return "refused";
    default:
      return undefined;
  }
}

function translateDone(state: TranslationState): ProviderEvent[] {
  if (state.pendingCompletion === undefined) {
    state.done = true;
    return [
      {
        type: "failed",
        error: { kind: "interrupted", message: "SSE stream ended before completion", retryable: true },
      },
    ];
  }

  state.done = true;
  return [{ type: "completed", reason: state.pendingCompletion }];
}

function applyFinishReason(finishReason: string, state: TranslationState): ProviderEvent[] {
  const reason = mapFinishReason(finishReason);
  if (reason === undefined) {
    state.done = true;
    return [
      {
        type: "failed",
        error: {
          kind: "protocol",
          message: `Unrecognised chat-completions finish_reason: ${finishReason}`,
          retryable: false,
        },
      },
    ];
  }

  if (reason !== "tool-use" && state.toolCalls.size > 0) {
    state.done = true;
    return [
      {
        type: "failed",
        error: {
          kind: "protocol",
          message: `Chat-completions finish_reason ${finishReason} arrived with pending tool calls`,
          retryable: false,
        },
      },
    ];
  }

  if (reason === "tool-use" && state.toolCalls.size === 0) {
    state.done = true;
    return [
      {
        type: "failed",
        error: {
          kind: "protocol",
          message: `Chat-completions finish_reason ${finishReason} arrived without tool calls`,
          retryable: false,
        },
      },
    ];
  }

  const events: ProviderEvent[] = [];
  if (reason === "tool-use") {
    const completion = state.toolCalls.completedCalls();
    if (!completion.ok) {
      state.done = true;
      return [
        {
          type: "failed",
          error: {
            kind: "protocol",
            message: completion.message,
            retryable: false,
          },
        },
      ];
    }
    for (const call of completion.calls) {
      events.push({ type: "tool-call-complete", call });
    }
  }

  state.pendingCompletion = reason;
  return events;
}

function finishWith(events: ProviderEvent[], state: TranslationState, failure: ProviderEvent): ProviderEvent[] {
  state.done = true;
  return [...events, failure];
}

function failIfContentArrivedAfterFinish(
  delta: Record<string, unknown>,
  state: TranslationState,
): ProviderEvent | undefined {
  if (state.pendingCompletion === undefined) return undefined;

  const content = stringField(delta, "content");
  const reasoning = stringField(delta, "reasoning_content");
  const toolCalls = arrayField(delta, "tool_calls");
  const hasPostFinishContent =
    (content !== undefined && content.length > 0) ||
    (reasoning !== undefined && reasoning.length > 0) ||
    (toolCalls !== undefined && toolCalls.length > 0);

  if (!hasPostFinishContent) return undefined;
  return {
    type: "failed",
    error: {
      kind: "protocol",
      message: "Chat-completions delta arrived after finish_reason",
      retryable: false,
    },
  };
}

function* toolCallUpdates(delta: Record<string, unknown>): Iterable<ToolCallUpdate> {
  const updates = arrayField(delta, "tool_calls");
  if (updates === undefined) return;

  for (const update of updates) {
    if (!isRecord(update)) continue;
    const index = numberField(update, "index");
    if (index === undefined) continue;
    const functionDelta = objectField(update, "function");
    yield {
      index,
      callId: stringField(update, "id"),
      name: functionDelta === undefined ? "" : (stringField(functionDelta, "name") ?? ""),
      argumentsDelta: functionDelta === undefined ? "" : (stringField(functionDelta, "arguments") ?? ""),
    };
  }
}

function extractUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = objectField(value, "usage");
  if (usage === undefined) return undefined;
  const inputTokens = numberField(usage, "prompt_tokens");
  const outputTokens = numberField(usage, "completion_tokens");
  const totalTokens = numberField(usage, "total_tokens");
  const result = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const choices = arrayField(value, "choices");
  const first = choices?.[0];
  return isRecord(first) ? first : undefined;
}
