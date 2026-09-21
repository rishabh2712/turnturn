import { resolve } from "node:path";
import { createAssistantEngine, createWorkspaceToolExecutor, MemoryDurableSink } from "@turnturn/assistant-core";
import type {
  AssistantEngine,
  DurableSink,
  ProviderPort,
  ToolExecutorPort,
  ToolPolicyPort,
} from "@turnturn/assistant-core/ports";
import type { DurableRecord } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { RuntimeClock, RuntimeIds } from "./ids.js";
import { LiveBroadcaster } from "./live-broadcaster.js";
import {
  type DiscoveryConnectionConfig,
  ModelCatalog,
  type ModelProfileConfig,
  type ProviderKind,
} from "./model-catalog.js";
import { DEFAULT_RAW_RESPONSE_MAX_BYTES } from "./observability/index.js";
import { LocalToolPolicy } from "./policy.js";

export type { DiscoveryConnectionConfig, ModelProfileConfig, ProviderKind } from "./model-catalog.js";

export interface AssistantServerConfig {
  readonly workspace: string;
  readonly provider: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly modelProfiles?: readonly ModelProfileConfig[];
  readonly defaultModelProfileId?: string;
  readonly discoveryConnections?: readonly DiscoveryConnectionConfig[];
  readonly trace?: boolean;
  readonly traceRawResponseMaxBytes?: number;
}

export interface AssistantRuntime {
  readonly config: AssistantServerConfig;
  readonly clock: RuntimeClock;
  readonly durable: DurableSink;
  readonly engine: AssistantEngine;
  readonly ids: RuntimeIds;
  readonly live: LiveBroadcaster;
  readonly models: ModelCatalog;
  readonly provider: ProviderPort;
  readonly tools: ToolExecutorPort;
  readonly policy: ToolPolicyPort;
  records(): readonly DurableRecord[];
}

export function createAssistantRuntime(config: AssistantServerConfig): AssistantRuntime {
  const workspace = resolve(config.workspace);
  const ids = new RuntimeIds();
  const clock = new RuntimeClock();
  const durable = new MemoryDurableSink();
  const live = new LiveBroadcaster({
    clock,
    ids,
    currentSequence: () => lastSequence(durable.records()),
  });
  const tools = createWorkspaceToolExecutor({
    roots: [workspace],
    defaultRoot: workspace,
  });
  const policy = new LocalToolPolicy();
  const defaultProfileId = config.defaultModelProfileId ?? "default";
  const models = new ModelCatalog(
    config.modelProfiles ?? [profileFromLegacyConfig(config, defaultProfileId)],
    defaultProfileId,
    config.discoveryConnections ?? [],
  );
  const provider = models.createProvider(models.defaultProfile);
  // Discovery augments configured profiles; startup never waits on (or fails because
  // of) a provider being reachable (D30).
  void models.refreshAll();
  const engine = createAssistantEngine({
    clock,
    durable,
    ids,
    live,
    provider,
    tools,
    policy,
  });

  return {
    config: { ...config, workspace },
    clock,
    durable,
    engine,
    ids,
    live,
    models,
    provider,
    tools,
    policy,
    records: () => durable.records(),
  };
}

export function runtimeDebugState(runtime: AssistantRuntime) {
  const records = runtime.records();
  const state = reduceEngineState(records);
  return {
    config: publicConfig(runtime.config),
    lastSequence: lastSequence(records),
    issues: state.issues,
    state: {
      conversations: [...state.conversations.values()],
      sessions: [...state.sessions.values()],
      turns: [...state.turns.values()],
      steps: [...state.steps.values()],
      tools: [...state.tools.values()],
      approvals: [...state.approvals.values()],
      lastSequence: state.lastSequence,
      issues: state.issues,
    },
  };
}

function publicConfig(config: AssistantServerConfig) {
  return {
    workspace: config.workspace,
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    trace: config.trace ?? false,
    traceRawResponseMaxBytes: config.traceRawResponseMaxBytes ?? DEFAULT_RAW_RESPONSE_MAX_BYTES,
  };
}

function profileFromLegacyConfig(config: AssistantServerConfig, id: string): ModelProfileConfig {
  return {
    id,
    connectionId: config.provider,
    label: config.model,
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  };
}

function lastSequence(records: readonly DurableRecord[]): number {
  return records.at(-1)?.sequence ?? 0;
}
