import { createAssistantEngine } from "@turnturn/assistant-core";
import type {
  AssistantEngine,
  CommandOutcome,
  EngineClock,
  EngineIds,
  LiveSink,
  ProviderPort,
  ToolExecutorPort,
  ToolPolicyPort,
} from "@turnturn/assistant-core/ports";
import {
  type CommandEnvelope,
  CommandTypes,
  type ConversationId,
  SCHEMA_VERSION,
  type SessionId,
} from "@turnturn/protocol";
import { RuntimeClock, RuntimeIds } from "./ids.js";
import type { ConversationStore } from "./storage/conversation-store.js";
import { JsonlSessionDurableSink } from "./storage/session-sink.js";

export interface SessionRuntime {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly durable: JsonlSessionDurableSink;
  readonly engine: AssistantEngine;
}

export interface SessionRuntimeRegistryOptions {
  readonly store: ConversationStore;
  readonly provider: ProviderPort;
  readonly tools: ToolExecutorPort;
  readonly policy: ToolPolicyPort;
  readonly live: LiveSink;
  readonly ids?: EngineIds;
  readonly clock?: EngineClock;
  readonly maxOpen?: number;
  readonly idleMs?: number;
}

interface RuntimeEntry {
  readonly runtime: SessionRuntime;
  activeCommands: number;
  lastUsed: number;
}

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<SessionId, RuntimeEntry>();
  private readonly opening = new Map<SessionId, Promise<SessionRuntime>>();
  private readonly ids: EngineIds;
  private readonly clock: EngineClock;
  private readonly maxOpen: number;
  private readonly idleMs: number;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: SessionRuntimeRegistryOptions) {
    this.ids = options.ids ?? new RuntimeIds();
    this.clock = options.clock ?? new RuntimeClock();
    this.maxOpen = options.maxOpen ?? 8;
    this.idleMs = options.idleMs ?? 10 * 60_000;
  }

  async open(conversationId: ConversationId, sessionId: SessionId): Promise<SessionRuntime> {
    const cached = this.runtimes.get(sessionId);
    if (cached !== undefined) {
      if (cached.runtime.conversationId !== conversationId) throw new Error("SESSION_NOT_IN_CONVERSATION");
      cached.lastUsed = Date.now();
      return cached.runtime;
    }
    const pending = this.opening.get(sessionId);
    if (pending !== undefined) {
      const runtime = await pending;
      if (runtime.conversationId !== conversationId) throw new Error("SESSION_NOT_IN_CONVERSATION");
      return runtime;
    }
    const created = this.createRuntime(conversationId, sessionId);
    this.opening.set(sessionId, created);
    try {
      const runtime = await created;
      this.runtimes.set(sessionId, { runtime, activeCommands: 0, lastUsed: Date.now() });
      this.sweep();
      return runtime;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  async submit(command: CommandEnvelope): Promise<CommandOutcome> {
    if (command.conversationId === undefined || command.sessionId === undefined) throw new Error("SESSION_NOT_FOUND");
    const runtime = await this.open(command.conversationId, command.sessionId);
    const entry = this.runtimes.get(runtime.sessionId);
    if (entry === undefined) throw new Error("SESSION_NOT_FOUND");
    entry.activeCommands += 1;
    try {
      return await runtime.engine.submit(command);
    } finally {
      entry.activeCommands -= 1;
      entry.lastUsed = Date.now();
      this.sweep();
      if ([...this.runtimes.values()].every((candidate) => candidate.activeCommands === 0)) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  size(): number {
    return this.runtimes.size;
  }

  isConversationBusy(conversationId: ConversationId): boolean {
    return [...this.runtimes.values()].some(
      (entry) => entry.runtime.conversationId === conversationId && entry.activeCommands > 0,
    );
  }

  async waitForIdle(): Promise<void> {
    if ([...this.runtimes.values()].every((entry) => entry.activeCommands === 0)) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  sweep(now = Date.now()): void {
    for (const [sessionId, entry] of this.runtimes) {
      if (entry.activeCommands === 0 && now - entry.lastUsed > this.idleMs) this.runtimes.delete(sessionId);
    }
    if (this.runtimes.size <= this.maxOpen) return;
    const idle = [...this.runtimes.entries()]
      .filter(([, entry]) => entry.activeCommands === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [sessionId] of idle) {
      if (this.runtimes.size <= this.maxOpen) break;
      this.runtimes.delete(sessionId);
    }
  }

  private async createRuntime(conversationId: ConversationId, sessionId: SessionId): Promise<SessionRuntime> {
    const conversation = await this.options.store.get(conversationId);
    const session = conversation?.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) throw new Error("SESSION_NOT_IN_CONVERSATION");
    const durable = await JsonlSessionDurableSink.open({
      path: this.options.store.sessionPath(conversationId, sessionId),
      conversationId,
      sessionId,
    });
    const engine = createAssistantEngine({
      provider: this.options.provider,
      tools: this.options.tools,
      policy: this.options.policy,
      durable,
      live: this.options.live,
      ids: this.ids,
      clock: this.clock,
    });
    if (durable.records().length === 0) {
      await engine.submit(this.createCommand(CommandTypes.ConversationCreate, conversationId, sessionId, {}));
      await engine.submit(
        this.createCommand(CommandTypes.SessionCreate, conversationId, sessionId, { provider: session.provider }),
      );
    }
    return { conversationId, sessionId, durable, engine };
  }

  private createCommand<T extends CommandTypes.ConversationCreate | CommandTypes.SessionCreate>(
    type: T,
    conversationId: ConversationId,
    sessionId: SessionId,
    payload: T extends CommandTypes.ConversationCreate ? Record<string, never> : { readonly provider: string },
  ): CommandEnvelope {
    return {
      schemaVersion: SCHEMA_VERSION,
      commandId: this.ids.commandId(),
      type,
      createdAt: this.clock.now(),
      conversationId,
      sessionId,
      payload,
    } as CommandEnvelope;
  }
}
