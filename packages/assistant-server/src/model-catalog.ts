import type { ProviderPort } from "@turnturn/assistant-core/ports";
import type { DiscoveredModelOption, DiscoveryOutcome, ToolCompatibility } from "./model-discovery/types.js";
import { createProviderConnection, type WireKind } from "./provider-registry.js";

export type { ToolCompatibility } from "./model-discovery/types.js";
export type { WireKind as ProviderKind } from "./provider-registry.js";

/** A manually configured profile. Always available, always takes priority over a discovered entry. */
export interface ModelProfileConfig {
  readonly id: string;
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
 * A connection the server discovers models from. In this deployment there is at most
 * one connection per wire kind (the env surface exposes one base URL/credential per
 * wire), so the wire kind doubles as the connection id. `label`/`locality` are display
 * facts only; `discover` is never invoked from the browser (D29) — it always runs
 * server-side against credentials resolved at startup.
 */
export interface DiscoveryConnectionConfig {
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
  private readonly discoveryConnections: ReadonlyMap<WireKind, DiscoveryConnectionConfig>;
  private readonly connectionState = new Map<WireKind, ConnectionState>();
  private readonly generation = new Map<WireKind, number>();

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
      entries.set(profile.id, profile);
    }
    if (!entries.has(defaultProfileId)) throw new Error(`Default model profile does not exist: ${defaultProfileId}`);
    this.profiles = entries;

    const connections = new Map<WireKind, DiscoveryConnectionConfig>();
    for (const connection of discoveryConnections) {
      if (connections.has(connection.wire))
        throw new Error(`Duplicate discovery connection for wire: ${connection.wire}`);
      connections.set(connection.wire, connection);
      this.connectionState.set(connection.wire, {
        status: "idle",
        stale: false,
        lastSuccessAt: null,
        error: null,
        discovered: [],
      });
    }
    this.discoveryConnections = connections;
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
    for (const [wire, state] of this.connectionState) {
      for (const option of state.discovered) {
        if (this.shadowedByConfigured(wire, option.modelId)) continue;
        result.push({
          id: this.discoveredId(wire, option.modelId),
          label: option.label,
          provider: wire,
          model: option.modelId,
        });
      }
    }
    return result;
  }

  /** The grouped, safe DTO behind `GET /api/providers`. Never includes a credential, header, or endpoint URL. */
  providerSnapshot(): ProviderCatalogSnapshot {
    const wires = new Set<WireKind>([
      ...this.discoveryConnections.keys(),
      ...[...this.profiles.values()].map((profile) => profile.provider),
    ]);
    const connections: PublicProviderConnection[] = [];
    for (const wire of wires) {
      const discoveryConfig = this.discoveryConnections.get(wire);
      const state = this.connectionState.get(wire);
      const configuredForWire = [...this.profiles.values()].filter((profile) => profile.provider === wire);
      const configuredModels: PublicModelOption[] = configuredForWire.map((profile) => ({
        id: profile.id,
        label: profile.label,
        model: profile.model,
        source: "configured",
        toolCompatibility: "supported",
        available: true,
      }));
      const discoveredModels: PublicModelOption[] = (state?.discovered ?? [])
        .filter((option) => !configuredForWire.some((profile) => profile.model === option.modelId))
        .map((option) => ({
          id: this.discoveredId(wire, option.modelId),
          label: option.label,
          model: option.modelId,
          source: "discovered",
          toolCompatibility: option.toolCompatibility,
          available: true,
        }));
      connections.push({
        id: wire,
        label: discoveryConfig?.label ?? wire,
        locality: discoveryConfig?.locality ?? (wire === "ollama" ? "local" : "remote"),
        wire,
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
    const myGeneration = (this.generation.get(connection.wire) ?? 0) + 1;
    this.generation.set(connection.wire, myGeneration);
    this.updateState(connection.wire, (state) => ({ ...state, status: "refreshing" }));

    const controller = new AbortController();
    let outcome: DiscoveryOutcome;
    try {
      outcome = await connection.discover(controller.signal);
    } catch {
      outcome = { status: "error", code: "NETWORK_ERROR" };
    }

    // Last-started-wins: a completion from a superseded refresh is discarded outright.
    if (this.generation.get(connection.wire) !== myGeneration) return;

    if (outcome.status === "ok") {
      this.updateState(connection.wire, () => ({
        status: "ok",
        stale: false,
        lastSuccessAt: new Date().toISOString(),
        error: null,
        discovered: outcome.models,
      }));
    } else {
      this.updateState(connection.wire, (state) => ({
        status: "error",
        stale: state.discovered.length > 0,
        lastSuccessAt: state.lastSuccessAt,
        error: { code: outcome.code },
        discovered: state.discovered,
      }));
    }
  }

  private updateState(wire: WireKind, update: (state: ConnectionState) => ConnectionState): void {
    const current = this.connectionState.get(wire) ?? {
      status: "idle",
      stale: false,
      lastSuccessAt: null,
      error: null,
      discovered: [],
    };
    this.connectionState.set(wire, update(current));
  }

  /** True for a configured profile, or a profile currently visible in the live discovery snapshot. */
  isAvailable(id: string): boolean {
    if (this.profiles.has(id)) return true;
    for (const [wire, state] of this.connectionState) {
      if (state.discovered.some((option) => this.discoveredId(wire, option.modelId) === id)) return true;
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
    // The on-the-fly connection id here is only a construction detail of
    // `createProviderConnection` (it must avoid the "__" profile-id separator); it is
    // not the profile id and is never observed outside this call.
    const connection = createProviderConnection({
      id: profile.provider,
      label: profile.label,
      locality: profile.provider === "ollama" ? "local" : "remote",
      wire: profile.provider,
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      ...(profile.apiKey === undefined ? {} : { apiKey: profile.apiKey }),
      ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
    });
    return connection.createAdapter(profile.model, profile.maxTokens);
  }

  private shadowedByConfigured(wire: WireKind, modelId: string): boolean {
    return [...this.profiles.values()].some((profile) => profile.provider === wire && profile.model === modelId);
  }

  private findDiscoveredProfile(id: string): ModelProfileConfig | undefined {
    for (const [wire, state] of this.connectionState) {
      const found = state.discovered.find((option) => this.discoveredId(wire, option.modelId) === id);
      if (found !== undefined) return this.profileForDiscovered(wire, found.modelId, found.label);
    }
    return undefined;
  }

  private reconstructPhantomProfile(id: string): ModelProfileConfig | undefined {
    const separatorIndex = id.indexOf(SEPARATOR);
    if (separatorIndex <= 0) return undefined;
    const wire = id.slice(0, separatorIndex) as WireKind;
    if (!this.discoveryConnections.has(wire)) return undefined;
    let model: string;
    try {
      model = Buffer.from(id.slice(separatorIndex + SEPARATOR.length), "base64url").toString("utf8");
    } catch {
      return undefined;
    }
    if (model.length === 0) return undefined;
    return this.profileForDiscovered(wire, model, model);
  }

  private profileForDiscovered(wire: WireKind, model: string, label: string): ModelProfileConfig {
    const connection = this.discoveryConnections.get(wire);
    return {
      id: this.discoveredId(wire, model),
      label,
      provider: wire,
      model,
      ...(connection?.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
      ...(connection?.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
      ...(connection?.maxTokens === undefined ? {} : { maxTokens: connection.maxTokens }),
    };
  }

  private discoveredId(wire: WireKind, modelId: string): string {
    return `${wire}${SEPARATOR}${Buffer.from(modelId, "utf8").toString("base64url")}`;
  }
}
