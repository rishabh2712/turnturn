import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports.js";
import { parseSseStream } from "../sse.js";
import { parseChatFrameData } from "./frames.js";
import { type ChatCompletionsHttpClient, requestChatCompletionsStream } from "./http.js";
import { createTranslationState, translateFrame, translateStreamEnd } from "./translate.js";

export interface OpenAIChatCompletionsAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxTokens?: number;
}

export class OpenAIChatCompletionsAdapter implements ProviderPort {
  readonly name = "openai-chat-completions";

  constructor(
    private readonly options: OpenAIChatCompletionsAdapterOptions,
    private readonly http: ChatCompletionsHttpClient = requestChatCompletionsStream,
  ) {}

  async *run(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const result = await this.http(this.options, request);
    if (result.kind === "failed") {
      yield result.event;
      return;
    }

    yield* parseOpenAIChatCompletionsEvents(result.body);
  }
}

export async function* parseOpenAIChatCompletionsEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const state = createTranslationState();

  for await (const event of parseSseStream(chunks)) {
    const frame = parseChatFrameData(event.data);
    if (frame.kind === "failed") {
      yield { type: "failed", error: { kind: "protocol", message: frame.message, retryable: false } };
      return;
    }
    for (const providerEvent of translateFrame(frame, state)) yield providerEvent;
    if (state.done) return;
  }

  for (const providerEvent of translateStreamEnd(state)) yield providerEvent;
}
