import type { ProviderPort } from "@turnturn/assistant-core/ports";
import type { DiscoveredModelOption, DiscoveryOutcome, ToolCompatibility } from "./model-discovery/types.js";
import { createProviderConnection, ProviderRegistry, type WireKind } from "./provider-registry.js";

export type { ToolCompatibility } from "./model-discovery/types.js";
export type { WireKind as ProviderKind } from "./provider-registry.js";

/** A manually configured profile. Always available, always takes priority over a discovered entry. */
export interface ModelProfileConfig {
  readonly id: string;
  /** Stable owner identity. Profiles on different connections may use the same wire and model id. */
  readonly connectionId: string;
  readonly label: string;
  readonly provider: WireKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

export interface PublicModelProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: WireKind;
  readonly model: string;
}

export interface StoredModelIdentity {
  readonly modelProfileId?: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * A connection the server discovers models from. Its stable id is deliberately
 * independent of its wire: LiteLLM and direct OpenAI can both speak the same wire.
 * `discover` is never invoked from the browser (D29) — it always runs server-side
 * against credentials resolved at startup.
 */
export interface DiscoveryConnectionConfig {
  readonly id: string;
  readonly wire: WireKind;
  readonly label: string;
  readonly locality: "local" | "remote";
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly discover: (signal: AbortSignal) => Promise<DiscoveryOutcome>;
}

export type ProviderConnectionStatus = "idle" | "refreshing" | "ok" | "error";

export interface PublicModelOption {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly source: "configured" | "discovered";
  readonly toolCompatibility: ToolCompatibility;
  readonly available: boolean;
}

export interface PublicProviderConnection {
  readonly id: string;
  readonly label: string;
  readonly locality: "local" | "remote";
  readonly wire: WireKind;
  readonly status: ProviderConnectionStatus;
  readonly stale: boolean;
  readonly lastSuccessAt: string | null;
  readonly error: { readonly code: string } | null;
  readonly models: readonly PublicModelOption[];
}

export interface ProviderCatalogSnapshot {
  readonly connections: readonly PublicProviderConnection[];
}

interface ConnectionState {
  status: ProviderConnectionStatus;
  stale: boolean;
  lastSuccessAt: string | null;
  error: { readonly code: string } | null;
  discovered: readonly DiscoveredModelOption[];
}

const SEPARATOR = "__";

export class ModelCatalog {
  private readonly profiles: ReadonlyMap<string, ModelProfileConfig>;
  private readonly providers: ProviderRegistry;
  private readonly discoveryConnections: ReadonlyMap<string, DiscoveryConnectionConfig>;
  private readonly connectionState = new Map<string, ConnectionState>();
  private readonly generation = new Map<string, number>();

  constructor(
    profiles: readonly ModelProfileConfig[],
    readonly defaultProfileId: string,
    discoveryConnections: readonly DiscoveryConnectionConfig[] = [],
  ) {
    const entries = new Map<string, ModelProfileConfig>();
    for (const profile of profiles) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile.id)) throw new Error(`Invalid model profile id: ${profile.id}`);
      if (entries.has(profile.id)) throw new Error(`Duplicate model profile id: ${profile.id}`);
      if (profile.label.trim().length === 0) throw new Error(`Model profile ${profile.id} needs a label`);
      // Runtime callers compiled before D30 may omit connectionId. Falling back to
      // the wire preserves those saved/startup configurations without conflating new
      // explicitly named connections.
      const normalized = { ...profile, connectionId: profile.connectionId ?? profile.provider };
      entries.set(profile.id, normalized);
    }
    if (!entries.has(defaultProfileId)) throw new Error(`Default model profile does not exist: ${defaultProfileId}`);
    this.profiles = entries;

    const connections = new Map<string, DiscoveryConnectionConfig>();
    for (const connection of discoveryConnections) {
      const normalized = { ...connection, id: connection.id ?? connection.wire };
      if (connections.has(normalized.id)) throw new Error(`Duplicate discovery connection id: ${normalized.id}`);
      connections.set(normalized.id, normalized);
      this.connectionState.set(normalized.id, {
        status: "idle",
        stale: false,
        lastSuccessAt: null,
        error: null,
        discovered: [],
      });
    }
    this.discoveryConnections = connections;

    const providerConnections = [...connections.values()].map((connection) => createProviderConnection(connection));
    const connectionIds = new Set(providerConnections.map((connection) => connection.id));
    for (const profile of entries.values()) {
      const configured = providerConnections.find((connection) => connection.id === profile.connectionId);
      if (configured !== undefined && configured.wire !== profile.provider) {
        throw new Error(`Model profile ${profile.id} wire does not match connection ${profile.connectionId}`);
      }
      if (connectionIds.has(profile.connectionId)) continue;
      providerConnections.push(
        createProviderConnection({
          id: profile.connectionId,
          label: profile.label,
          locality: profile.provider === "ollama" ? "local" : "remote",
          wire: profile.provider,
          ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
          ...(profile.apiKey === undefined ? {} : { apiKey: profile.apiKey }),
          ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
        }),
      );
      connectionIds.add(profile.connectionId);
    }
    this.providers = new ProviderRegistry(providerConnections);
  }

  get defaultProfile(): ModelProfileConfig {
    return this.require(this.defaultProfileId);
  }

  /** Compatibility projection for `/api/runtime.models` (D30) — not a second source of truth. */
  listPublic(): readonly PublicModelProfile[] {
    const result: PublicModelProfile[] = [...this.profiles.values()].map(({ id, label, provider, model }) => ({
      id,
      label,
      provider,
      model,
    }));
    for (const [connectionId, state] of this.connectionState) {
      for (const option of state.discovered) {
        const connection = this.providers.require(connectionId);
        if (this.shadowedByConfigured(connectionId, option.modelId)) continue;
        result.push({
          id: this.discoveredId(connectionId, option.modelId),
          label: option.label,
          provider: connection.wire,
          model: option.modelId,
        });
      }
    }
    return result;
  }

  /** The grouped, safe DTO behind `GET /api/providers`. Never includes a credential, header, or endpoint URL. */
  providerSnapshot(): ProviderCatalogSnapshot {
    const connections: PublicProviderConnection[] = [];
    for (const connection of this.providers.list()) {
      const discoveryConfig = this.discoveryConnections.get(connection.id);
      const state = this.connectionState.get(connection.id);
      const configuredForConnection = [...this.profiles.values()].filter(
        (profile) => profile.connectionId === connection.id,
      );
      const configuredModels: PublicModelOption[] = configuredForConnection.map((profile) => ({
        id: profile.id,
        label: profile.label,
        model: profile.model,
        source: "configured",
        toolCompatibility: "supported",
        available: true,
      }));
      const discoveredModels: PublicModelOption[] = (state?.discovered ?? [])
        .filter((option) => !configuredForConnection.some((profile) => profile.model === option.modelId))
        .map((option) => ({
          id: this.discoveredId(connection.id, option.modelId),
          label: option.label,
          model: option.modelId,
          source: "discovered",
          toolCompatibility: option.toolCompatibility,
          available: true,
        }));
      connections.push({
        id: connection.id,
        label: discoveryConfig?.label ?? connection.label,
        locality: discoveryConfig?.locality ?? connection.locality,
        wire: connection.wire,
        status: state?.status ?? "idle",
        stale: state?.stale ?? false,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        error: state?.error ?? null,
        models: [...configuredModels, ...discoveredModels],
      });
    }
    return { connections };
  }

  /**
   * Refreshes every connection with a discoverer, in parallel. One connection failing
   * or timing out only marks that connection `error`/stale; it never throws, never
   * removes configured profiles, and never prevents other connections from updating
   * (D30). Overlapping refreshes for the same connection are last-started-wins.
   */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.discoveryConnections.values()].map((connection) => this.refreshOne(connection)));
  }

  private async refreshOne(connection: DiscoveryConnectionConfig): Promise<void> {
    const myGeneration = (this.generation.get(connection.id) ?? 0) + 1;
    this.generation.set(connection.id, myGeneration);
    this.updateState(connection.id, (state) => ({ ...state, status: "refreshing" }));

    const controller = new AbortController();
    let outcome: DiscoveryOutcome;
    try {
      outcome = await connection.discover(controller.signal);
    } catch {
      outcome = { status: "error", code: "NETWORK_ERROR" };
    }

    // Last-started-wins: a completion from a superseded refresh is discarded outright.
    if (this.generation.get(connection.id) !== myGeneration) return;

    if (outcome.status === "ok") {
      this.updateState(connection.id, () => ({
        status: "ok",
        stale: false,
        lastSuccessAt: new Date().toISOString(),
        error: null,
        discovered: outcome.models,
      }));
    } else {
      this.updateState(connection.id, (state) => ({
        status: "error",
        stale: state.discovered.length > 0,
        lastSuccessAt: state.lastSuccessAt,
        error: { code: outcome.code },
        discovered: state.discovered,
      }));
    }
  }

  private updateState(connectionId: string, update: (state: ConnectionState) => ConnectionState): void {
    const current = this.connectionState.get(connectionId) ?? {
      status: "idle",
      stale: false,
      lastSuccessAt: null,
      error: null,
      discovered: [],
    };
    this.connectionState.set(connectionId, update(current));
  }

  /** True for a configured profile, or a profile currently visible in the live discovery snapshot. */
  isAvailable(id: string): boolean {
    if (this.profiles.has(id)) return true;
    for (const [connectionId, state] of this.connectionState) {
      if (state.discovered.some((option) => this.discoveredId(connectionId, option.modelId) === id)) return true;
    }
    return false;
  }

  require(id: string): ModelProfileConfig {
    const configured = this.profiles.get(id);
    if (configured !== undefined) return configured;
    const discovered = this.findDiscoveredProfile(id);
    if (discovered !== undefined) return discovered;
    // Catalog drift (D30): a persisted deterministic id whose model has fallen out of
    // the live discovery snapshot still reconstructs, as long as its connection is
    // still configured, so an old session can reopen and stay readable. `isAvailable`
    // is what a caller must check separately before allowing a *new* invocation.
    const phantom = this.reconstructPhantomProfile(id);
    if (phantom !== undefined) return phantom;
    throw new Error("MODEL_PROFILE_NOT_FOUND");
  }

  resolve(identity: StoredModelIdentity): ModelProfileConfig {
    if (identity.modelProfileId !== undefined) {
      const profile = this.require(identity.modelProfileId);
      if (profile.provider !== identity.provider || profile.model !== identity.model) {
        throw new Error("MODEL_PROFILE_SESSION_MISMATCH");
      }
      return profile;
    }
    const matches = [...this.profiles.values()].filter(
      (profile) => profile.provider === identity.provider && profile.model === identity.model,
    );
    if (matches.length !== 1) throw new Error("MODEL_PROFILE_NOT_FOUND");
    return matches[0] as ModelProfileConfig;
  }

  createProvider(profile: ModelProfileConfig): ProviderPort {
    const connection = this.providers.require(profile.connectionId ?? profile.provider);
    return connection.createAdapter(profile.model, profile.maxTokens);
  }

  private shadowedByConfigured(connectionId: string, modelId: string): boolean {
    return [...this.profiles.values()].some(
      (profile) => profile.connectionId === connectionId && profile.model === modelId,
    );
  }

  private findDiscoveredProfile(id: string): ModelProfileConfig | undefined {
    for (const [connectionId, state] of this.connectionState) {
      const found = state.discovered.find((option) => this.discoveredId(connectionId, option.modelId) === id);
      if (found !== undefined) return this.profileForDiscovered(connectionId, found.modelId, found.label);
    }
    return undefined;
  }

  private reconstructPhantomProfile(id: string): ModelProfileConfig | undefined {
    const separatorIndex = id.indexOf(SEPARATOR);
    if (separatorIndex <= 0) return undefined;
    const connectionId = id.slice(0, separatorIndex);
    if (!this.discoveryConnections.has(connectionId)) return undefined;
    let model: string;
    try {
      model = Buffer.from(id.slice(separatorIndex + SEPARATOR.length), "base64url").toString("utf8");
    } catch {
      return undefined;
    }
    if (model.length === 0) return undefined;
    return this.profileForDiscovered(connectionId, model, model);
  }

  private profileForDiscovered(connectionId: string, model: string, label: string): ModelProfileConfig {
    const connection = this.providers.require(connectionId);
    return {
      id: this.discoveredId(connectionId, model),
      connectionId,
      label,
      provider: connection.wire,
      model,
      ...(connection.maxTokens === undefined ? {} : { maxTokens: connection.maxTokens }),
    };
  }

  private discoveredId(connectionId: string, modelId: string): string {
    return `${connectionId}${SEPARATOR}${Buffer.from(modelId, "utf8").toString("base64url")}`;
  }
}
