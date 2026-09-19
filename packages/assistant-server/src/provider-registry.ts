import {
  AnthropicMessagesAdapter,
  OpenAIChatCompletionsAdapter,
  ollamaChatCompletions,
} from "@turnturn/assistant-core";
import type { ProviderPort } from "@turnturn/assistant-core/ports";

/**
 * The wire adapter a provider connection speaks. This is never inferred from a model
 * name or label — only the connection that owns a profile decides it (D30). A LiteLLM
 * connection routing a model literally named "claude-..." still speaks
 * `openai-chat-completions`; a direct Anthropic connection speaks `anthropic-messages`.
 */
export type WireKind = "anthropic-messages" | "ollama" | "openai-chat-completions";

export interface ProviderConnectionConfig {
  /** Stable connection identity. Must not contain "__" (reserved as the profile-id separator). */
  readonly id: string;
  readonly label: string;
  readonly locality: "local" | "remote";
  readonly wire: WireKind;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/**
 * A configured connection: private credential and endpoint material plus the one wire
 * adapter factory it owns. `createAdapter` never looks at the model id to choose an
 * adapter class — it is fixed by `wire` at construction time.
 */
export interface ProviderConnection extends ProviderConnectionConfig {
  createAdapter(model: string, maxTokens?: number): ProviderPort;
}

export function createProviderConnection(config: ProviderConnectionConfig): ProviderConnection {
  if (config.id.includes("__")) {
    throw new Error(`Provider connection id must not contain "__": ${config.id}`);
  }
  return {
    ...config,
    createAdapter: (model: string, maxTokens?: number): ProviderPort => {
      const effectiveMaxTokens = maxTokens ?? config.maxTokens;
      switch (config.wire) {
        case "anthropic-messages": {
          if (config.apiKey === undefined || config.apiKey.length === 0) {
            throw new Error(`Provider connection ${config.id} requires an Anthropic API key`);
          }
          return new AnthropicMessagesAdapter({
            apiKey: config.apiKey,
            model,
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
          });
        }
        case "ollama":
          return ollamaChatCompletions({
            model,
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
          });
        case "openai-chat-completions":
          return new OpenAIChatCompletionsAdapter({
            baseUrl: config.baseUrl ?? "https://api.openai.com",
            model,
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
          });
      }
    },
  };
}

/** Private registry of configured connections. Never serialized; `ModelCatalog` produces the public projection. */
export class ProviderRegistry {
  private readonly byId: ReadonlyMap<string, ProviderConnection>;

  constructor(connections: readonly ProviderConnection[]) {
    const byId = new Map<string, ProviderConnection>();
    for (const connection of connections) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(connection.id)) {
        throw new Error(`Invalid provider connection id: ${connection.id}`);
      }
      if (byId.has(connection.id)) throw new Error(`Duplicate provider connection id: ${connection.id}`);
      byId.set(connection.id, connection);
    }
    this.byId = byId;
  }

  list(): readonly ProviderConnection[] {
    return [...this.byId.values()];
  }

  find(id: string): ProviderConnection | undefined {
    return this.byId.get(id);
  }

  require(id: string): ProviderConnection {
    const connection = this.byId.get(id);
    if (connection === undefined) throw new Error("PROVIDER_CONNECTION_NOT_FOUND");
    return connection;
  }
}
