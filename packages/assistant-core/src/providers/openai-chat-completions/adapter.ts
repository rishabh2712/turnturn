import {
  noopStepObservation,
  type ProviderAttemptObservation,
  type StepObservation,
} from "../../observability/types.js";
import type { ProviderEvent, ProviderPort, ProviderRequest, ProviderUsage } from "../../ports.js";
import { parseSseStream } from "../sse.js";
import { isRecord, parseChatFrameData, stringField } from "./frames.js";
import { type ChatCompletionsHttpClient, requestChatCompletionsStream } from "./http.js";
import { createTranslationState, translateFrame, translateStreamEnd } from "./translate.js";

export interface OpenAIChatCompletionsAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxTokens?: number;
  readonly nowMs?: () => number;
}

export class OpenAIChatCompletionsAdapter implements ProviderPort {
  readonly name = "openai-chat-completions";

  constructor(
    private readonly options: OpenAIChatCompletionsAdapterOptions,
    private readonly http: ChatCompletionsHttpClient = requestChatCompletionsStream,
  ) {}

  async *run(
    request: ProviderRequest,
    stepObservation: StepObservation = noopStepObservation,
  ): AsyncIterable<ProviderEvent> {
    const attempt = stepObservation.startProviderAttempt({ provider: this.name, model: this.options.model });
    const startedAt = this.nowMs();
    const result = await this.http(this.options, request, { beforeFetch: (wire) => attempt.wireRequest(wire) });
    observeResponseMetadata(attempt, result);
    if (result.kind === "failed") {
      attempt.providerEvent(result.event);
      if (request.signal.aborted) attempt.cancel(abortReason(request.signal));
      else attempt.fail(result.event.error);
      yield result.event;
      return;
    }

    let usage: ProviderUsage | undefined;
    let responseId: string | undefined;
    for await (const event of parseOpenAIChatCompletionsEvents(result.body, {
      onResponseId(id) {
        responseId ??= id;
      },
      onRawFrame: (frame) => attempt.rawResponseFrame(frame),
      onProviderEvent: (event) => attempt.providerEvent(event),
    })) {
      if (event.type === "usage") usage = event.usage;
      if (event.type === "completed") {
        const terminalUsage = event.usage ?? usage;
        attempt.complete({
          reason: event.reason,
          ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
          ...(responseId === undefined ? {} : { responseId }),
          ...(result.upstreamRequestId === undefined ? {} : { upstreamRequestId: result.upstreamRequestId }),
          durationMs: this.nowMs() - startedAt,
        });
      } else if (event.type === "failed") {
        if (request.signal.aborted) attempt.cancel(abortReason(request.signal));
        else attempt.fail(event.error);
      }
      yield event;
    }
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }
}

function observeResponseMetadata(
  attempt: ProviderAttemptObservation,
  result: Awaited<ReturnType<ChatCompletionsHttpClient>>,
): void {
  if (result.status === undefined) return;
  attempt.responseMetadata({
    status: result.status,
    ...(result.upstreamRequestId === undefined ? {} : { upstreamRequestId: result.upstreamRequestId }),
  });
}

function abortReason(signal: AbortSignal): string | undefined {
  return signal.reason === undefined ? undefined : String(signal.reason);
}

export interface ChatStreamTranslationHooks {
  readonly onResponseId?: (responseId: string) => void;
  readonly onRawFrame?: (frame: { readonly data: string; readonly event?: string }) => void;
  readonly onProviderEvent?: (event: ProviderEvent) => void;
}

export async function* parseOpenAIChatCompletionsEvents(
  chunks: AsyncIterable<Uint8Array>,
  hooks: ChatStreamTranslationHooks = {},
): AsyncIterable<ProviderEvent> {
  const state = createTranslationState();

  for await (const event of parseSseStream(chunks)) {
    hooks.onRawFrame?.({ data: event.data, ...(event.event === undefined ? {} : { event: event.event }) });
    const frame = parseChatFrameData(event.data);
    if (frame.kind === "failed") {
      const failure: ProviderEvent = {
        type: "failed",
        error: { kind: "protocol", message: frame.message, retryable: false },
      };
      hooks.onProviderEvent?.(failure);
      yield failure;
      return;
    }
    if (frame.kind === "chat-frame" && isRecord(frame.value)) {
      const responseId = stringField(frame.value, "id");
      if (responseId !== undefined) hooks.onResponseId?.(responseId);
    }
    for (const providerEvent of translateFrame(frame, state)) {
      hooks.onProviderEvent?.(providerEvent);
      yield providerEvent;
    }
    if (state.done) return;
  }

  for (const providerEvent of translateStreamEnd(state)) {
    hooks.onProviderEvent?.(providerEvent);
    yield providerEvent;
  }
}
