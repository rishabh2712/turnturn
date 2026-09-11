import {
  type ApprovalId,
  type CommandId,
  type ConversationId,
  type DurableRecord,
  type DurableRecordDraft,
  type EventId,
  formatApprovalId,
  formatCommandId,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  type JsonValue,
  type LiveEvent,
  type RecordId,
  type SerializedError,
  type SessionId,
  type StepId,
  serializeJson,
  type ToolCallId,
  type TurnId,
} from "@turnturn/protocol";
import type {
  DurableSink,
  EngineClock,
  EngineIds,
  LiveSink,
  PolicyDecision,
  PolicyRequest,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutorPort,
  ToolInputValidation,
  ToolOutcome,
  ToolPolicyPort,
} from "./ports.js";

const uuid = (index: number): string => `018f1f4e-8d5f-7abc-8123-${String(index).padStart(12, "0")}`;

export class SequentialIds implements EngineIds {
  private next = 1;

  conversationId(): ConversationId {
    return this.make(formatConversationId);
  }

  sessionId(): SessionId {
    return this.make(formatSessionId);
  }

  turnId(): TurnId {
    return this.make(formatTurnId);
  }

  stepId(): StepId {
    return this.make(formatStepId);
  }

  toolCallId(): ToolCallId {
    return this.make(formatToolCallId);
  }

  approvalId(): ApprovalId {
    return this.make(formatApprovalId);
  }

  commandId(): CommandId {
    return this.make(formatCommandId);
  }

  recordId(): RecordId {
    return this.make(formatRecordId);
  }

  eventId(): EventId {
    return this.make(formatEventId);
  }

  private make<T>(factory: (uuid: string) => T): T {
    const value = factory(uuid(this.next));
    this.next += 1;
    return value;
  }
}

export class FixedClock implements EngineClock {
  constructor(private readonly iso = "2026-01-01T00:00:00.000Z") {}

  now(): string {
    return this.iso;
  }
}

export class MemoryDurableSink implements DurableSink {
  private readonly stored: DurableRecord[] = [];

  async append(draft: DurableRecordDraft): Promise<DurableRecord> {
    serializeJson(draft);
    const record = { ...draft, sequence: this.stored.length + 1 } as DurableRecord;
    serializeJson(record);
    this.stored.push(record);
    return record;
  }

  records(): readonly DurableRecord[] {
    return this.stored;
  }
}

export class MemoryLiveSink implements LiveSink {
  readonly events: LiveEvent[] = [];
  throwOnPublish = false;

  publish(event: LiveEvent): void {
    if (this.throwOnPublish) throw new Error("live sink failed");
    serializeJson(event);
    this.events.push(event);
  }
}

export class ScriptedProvider implements ProviderPort {
  readonly name: string;
  readonly requests: ProviderRequest[] = [];
  private index = 0;

  constructor(batches: readonly (readonly ProviderEvent[])[], name = "scripted") {
    this.batches = batches.map((batch) => [...batch]);
    this.name = name;
  }

  private readonly batches: readonly ProviderEvent[][];

  async *run(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    const batch = this.batches[this.index] ?? [];
    this.index += 1;
    for (const event of batch) {
      if (request.signal.aborted) return;
      yield event;
    }
  }
}

export class StaticPolicy implements ToolPolicyPort {
  readonly requests: PolicyRequest[] = [];

  constructor(private readonly decision: PolicyDecision = { kind: "allow" }) {}

  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    this.requests.push(request);
    return this.decision;
  }
}

export const allowPolicy = (): ToolPolicyPort => new StaticPolicy({ kind: "allow" });
export const denyPolicy = (error: SerializedError = testError("DENIED")): ToolPolicyPort =>
  new StaticPolicy({ kind: "deny", error });
export const askPolicy = (reason = "approval required"): ToolPolicyPort => new StaticPolicy({ kind: "ask", reason });

export class MemoryToolExecutor implements ToolExecutorPort {
  readonly requests: ToolExecutionRequest[] = [];

  constructor(
    private readonly handler: (request: ToolExecutionRequest) => Promise<ToolOutcome> | ToolOutcome,
    private readonly toolDefinitions: readonly ToolDefinition[] = [],
  ) {}

  definitions(): readonly ToolDefinition[] {
    return this.toolDefinitions;
  }

  validate(request: { readonly input: JsonValue }): ToolInputValidation {
    return { ok: true, input: request.input };
  }

  async execute(request: ToolExecutionRequest): Promise<ToolOutcome> {
    this.requests.push(request);
    return await this.handler(request);
  }
}

export function completed(output: JsonValue): ToolOutcome {
  return { kind: "completed", output };
}

export function failed(code = "TOOL_FAILED", message = "tool failed"): ToolOutcome {
  return { kind: "failed", error: testError(code, message) };
}

export function testError(code: string, message = code): SerializedError {
  return { code, message, retryable: false, fatal: false };
}
