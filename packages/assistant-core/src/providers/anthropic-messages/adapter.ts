import {
  noopStepObservation,
  type ProviderAttemptObservation,
  type StepObservation,
} from "../../observability/types.js";
import type { ProviderEvent, ProviderPort, ProviderRequest, ProviderUsage } from "../../ports.js";
import { parseSseStream } from "../sse.js";
import { type AnthropicMessagesHttpClient, requestAnthropicMessagesStream } from "./http.js";
import { createAnthropicTranslationState, translateAnthropicFrame, translateAnthropicStreamEnd } from "./translate.js";

export interface AnthropicMessagesAdapterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly anthropicVersion?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly nowMs?: () => number;
}

export class AnthropicMessagesAdapter implements ProviderPort {
  readonly name = "anthropic-messages";
  private readonly options: AnthropicMessagesAdapterOptions & { readonly baseUrl: string };

  constructor(
    options: AnthropicMessagesAdapterOptions,
    private readonly http: AnthropicMessagesHttpClient = requestAnthropicMessagesStream,
  ) {
    this.options = { ...options, baseUrl: options.baseUrl ?? "https://api.anthropic.com" };
  }

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
    for await (const event of parseAnthropicMessagesEvents(result.body, {
      onRawFrame: (frame) => attempt.rawResponseFrame(frame),
      onProviderEvent: (providerEvent) => attempt.providerEvent(providerEvent),
      onResponseId: (id) => {
        responseId ??= id;
      },
    })) {
      if (event.type === "usage") usage = mergeUsage(usage, event.usage);
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

export interface AnthropicStreamHooks {
  readonly onRawFrame?: (frame: { readonly data: string; readonly event?: string }) => void;
  readonly onProviderEvent?: (event: ProviderEvent) => void;
  readonly onResponseId?: (responseId: string) => void;
}

export async function* parseAnthropicMessagesEvents(
  chunks: AsyncIterable<Uint8Array>,
  hooks: AnthropicStreamHooks = {},
): AsyncIterable<ProviderEvent> {
  const state = createAnthropicTranslationState();
  for await (const frame of parseSseStream(chunks)) {
    hooks.onRawFrame?.({ data: frame.data, ...(frame.event === undefined ? {} : { event: frame.event }) });
    const events = translateAnthropicFrame(frame.event, frame.data, state);
    if (state.responseId !== undefined) hooks.onResponseId?.(state.responseId);
    for (const event of events) {
      hooks.onProviderEvent?.(event);
      yield event;
    }
    if (state.done) return;
  }
  for (const event of translateAnthropicStreamEnd(state)) {
    hooks.onProviderEvent?.(event);
    yield event;
  }
}

function observeResponseMetadata(
  attempt: ProviderAttemptObservation,
  result: Awaited<ReturnType<AnthropicMessagesHttpClient>>,
): void {
  if (result.status === undefined) return;
  attempt.responseMetadata({
    status: result.status,
    ...(result.upstreamRequestId === undefined ? {} : { upstreamRequestId: result.upstreamRequestId }),
  });
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

function abortReason(signal: AbortSignal): string | undefined {
  return signal.reason === undefined ? undefined : String(signal.reason);
}
