import { OpenAIChatCompletionsAdapter, type OpenAIChatCompletionsAdapterOptions } from "./adapter.js";

export { OpenAIChatCompletionsAdapter };
export type { OpenAIChatCompletionsAdapterOptions };

export type OllamaChatCompletionsPresetOptions = Omit<OpenAIChatCompletionsAdapterOptions, "apiKey" | "baseUrl"> & {
  readonly baseUrl?: string;
};

export function ollamaChatCompletions(options: OllamaChatCompletionsPresetOptions): OpenAIChatCompletionsAdapter {
  return new OpenAIChatCompletionsAdapter({
    ...options,
    baseUrl: options.baseUrl ?? "http://127.0.0.1:11434",
  });
}
