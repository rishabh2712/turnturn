import { Buffer } from "node:buffer";
import { type ModelContextSnapshot, projectModelContext } from "@turnturn/assistant-core/context";
import type {
  ApprovalObservation,
  ProviderAttemptCompletion,
  ProviderAttemptObservation,
  ProviderAttemptStart,
  ProviderResponseMetadataObservation,
  ProviderStepCompletion,
  ProviderWireRequestObservation,
  RawProviderFrameObservation,
  StepObservation,
  StepObservationScope,
  ToolObservation,
  TurnCompletionObservation,
  TurnObservation,
  TurnObservationScope,
} from "@turnturn/assistant-core/observability";
import type { ProviderEvent, ProviderFailure } from "@turnturn/assistant-core/ports";
import { type JsonValue, type SerializedError, serializeJson } from "@turnturn/protocol";
import type { AttemptTraceScope, StepTraceScope } from "./trace-types.js";
import type { TraceBundleWriter } from "./trace-writer.js";

export interface TraceHandleContext {
  readonly rawResponseMaxBytes: number;
  readonly toolOutputMaxBytes: number;
  schedule(operation: string, action: () => Promise<unknown>): void;
}

export function createTraceTurnObservation(
  context: TraceHandleContext,
  writer: Promise<TraceBundleWriter>,
  scope: TurnObservationScope,
  createAttemptId: () => string,
): TurnObservation {
  const turn = new TraceTurnObservation(context, writer, scope, createAttemptId);
  turn.started();
  return turn;
}

class TraceTurnObservation implements TurnObservation {
  private readonly toolOutputBytes = new Map<string, number>();
  private readonly truncatedToolOutput = new Set<string>();

  constructor(
    private readonly context: TraceHandleContext,
    private readonly writer: Promise<TraceBundleWriter>,
    private readonly scope: TurnObservationScope,
    private readonly createAttemptId: () => string,
  ) {}

  started(): void {
    this.append("turn.started");
  }

  startStep(scope: StepObservationScope): StepObservation {
    const step = new TraceStepObservation(this.context, this.writer, scope, this.createAttemptId);
    step.started();
    return step;
  }

  observeTool(event: ToolObservation): void {
    const bounded = this.boundToolOutput(event);
    if (bounded === undefined) return;
    const scope = { ...bounded.scope };
    this.context.schedule("tool.observe", async () =>
      (await this.writer).append({ type: "tool.observed", scope, data: toJson(bounded) }),
    );
  }

  private boundToolOutput(event: ToolObservation): ToolObservation | undefined {
    if (event.type !== "execution-output") return event;
    const key = event.scope.toolCallId;
    if (this.truncatedToolOutput.has(key)) return undefined;
    const nextBytes = (this.toolOutputBytes.get(key) ?? 0) + Buffer.byteLength(event.text, "utf8");
    if (nextBytes <= this.context.toolOutputMaxBytes) {
      this.toolOutputBytes.set(key, nextBytes);
      return event;
    }
    this.truncatedToolOutput.add(key);
    return {
      type: "execution-output-truncated",
      scope: event.scope,
      boundBytes: this.context.toolOutputMaxBytes,
    };
  }

  observeApproval(event: ApprovalObservation): void {
    const scope = { ...event.scope };
    this.context.schedule("approval.observe", async () =>
      (await this.writer).append({ type: "approval.observed", scope, data: toJson(event) }),
    );
  }

  complete(outcome: TurnCompletionObservation): void {
    this.append("turn.completed", outcome);
  }

  fail(error: SerializedError): void {
    this.append("turn.failed", error);
  }

  cancel(reason?: string): void {
    this.append("turn.cancelled", reason === undefined ? undefined : { reason });
  }

  private append(type: "turn.started" | "turn.completed" | "turn.failed" | "turn.cancelled", data?: unknown): void {
    this.context.schedule(type, async () =>
      (await this.writer).append({ type, scope: this.scope, ...(data === undefined ? {} : { data: toJson(data) }) }),
    );
  }
}

class TraceStepObservation implements StepObservation {
  constructor(
    private readonly context: TraceHandleContext,
    private readonly writer: Promise<TraceBundleWriter>,
    private readonly scope: StepObservationScope,
    private readonly createAttemptId: () => string,
  ) {}

  started(): void {
    this.append("step.started");
  }

  modelContext(context: ModelContextSnapshot): void {
    this.context.schedule("step.model-context", async () =>
      (await this.writer).append(
        { type: "step.model-context", scope: this.scope, data: toJson(projectModelContext(context)) },
        toJson(context),
      ),
    );
  }

  startProviderAttempt(attempt: ProviderAttemptStart): ProviderAttemptObservation {
    const scope: AttemptTraceScope = { ...this.scope, attemptId: this.createAttemptId() };
    const observed = new TraceProviderAttemptObservation(this.context, this.writer, scope);
    observed.started(attempt);
    return observed;
  }

  complete(outcome: ProviderStepCompletion): void {
    this.append("step.completed", outcome);
  }

  fail(error: ProviderFailure): void {
    this.append("step.failed", error);
  }

  cancel(reason?: string): void {
    this.append("step.cancelled", reason === undefined ? undefined : { reason });
  }

  private append(type: "step.started" | "step.completed" | "step.failed" | "step.cancelled", data?: unknown): void {
    const scope: StepTraceScope = this.scope;
    this.context.schedule(type, async () =>
      (await this.writer).append({ type, scope, ...(data === undefined ? {} : { data: toJson(data) }) }),
    );
  }
}

class TraceProviderAttemptObservation implements ProviderAttemptObservation {
  private rawResponseBytes = 0;
  private rawResponseTruncated = false;

  constructor(
    private readonly context: TraceHandleContext,
    private readonly writer: Promise<TraceBundleWriter>,
    private readonly scope: AttemptTraceScope,
  ) {}

  started(attempt: ProviderAttemptStart): void {
    this.append("attempt.started", attempt);
  }

  wireRequest(request: ProviderWireRequestObservation): void {
    this.context.schedule("attempt.wire-request", async () =>
      (await this.writer).append(
        {
          type: "attempt.wire-request",
          scope: this.scope,
          data: toJson({ method: request.method, route: request.route }),
        },
        request.body,
      ),
    );
  }

  responseMetadata(metadata: ProviderResponseMetadataObservation): void {
    this.append("attempt.response-metadata", metadata);
  }

  rawResponseFrame(frame: RawProviderFrameObservation): void {
    if (this.rawResponseTruncated) return;
    const frameBytes = Buffer.byteLength(frame.data, "utf8");
    if (this.rawResponseBytes + frameBytes > this.context.rawResponseMaxBytes) {
      this.rawResponseTruncated = true;
      this.issue({ kind: "payload-truncated", boundBytes: this.context.rawResponseMaxBytes });
      return;
    }
    this.rawResponseBytes += frameBytes;
    this.context.schedule("attempt.raw-response-frame", async () =>
      (await this.writer).append(
        {
          type: "attempt.raw-response-frame",
          scope: this.scope,
          ...(frame.event === undefined ? {} : { data: toJson({ event: frame.event }) }),
        },
        frame.data,
      ),
    );
  }

  providerEvent(event: ProviderEvent): void {
    this.append("attempt.provider-event", event);
  }

  complete(outcome: ProviderAttemptCompletion): void {
    this.append("attempt.completed", outcome);
  }

  fail(error: ProviderFailure): void {
    this.append("attempt.failed", error);
  }

  cancel(reason?: string): void {
    this.append("attempt.cancelled", reason === undefined ? undefined : { reason });
  }

  issue(issue: Parameters<ProviderAttemptObservation["issue"]>[0]): void {
    this.append("attempt.issue", issue);
  }

  private append(
    type:
      | "attempt.started"
      | "attempt.response-metadata"
      | "attempt.provider-event"
      | "attempt.completed"
      | "attempt.failed"
      | "attempt.cancelled"
      | "attempt.issue",
    data?: unknown,
  ): void {
    this.context.schedule(type, async () =>
      (await this.writer).append({ type, scope: this.scope, ...(data === undefined ? {} : { data: toJson(data) }) }),
    );
  }
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(serializeJson(value)) as JsonValue;
}
