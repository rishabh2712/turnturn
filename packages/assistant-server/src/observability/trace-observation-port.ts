import { randomUUID } from "node:crypto";
import type {
  ObservationFailure,
  ObservationPort,
  TurnObservation,
  TurnObservationScope,
} from "@turnturn/assistant-core/observability";
import { createTraceTurnObservation, type TraceHandleContext } from "./trace-handles.js";
import { TRACE_SCHEMA_VERSION, type TraceManifest } from "./trace-types.js";
import { TraceWriteQueue } from "./trace-write-queue.js";
import { TraceBundleWriter } from "./trace-writer.js";

export const DEFAULT_RAW_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export interface TraceObservationPortOptions {
  readonly tracesRoot: string;
  readonly provider: string;
  readonly model: string;
  readonly now?: () => string;
  readonly traceId?: () => string;
  readonly attemptId?: () => string;
  readonly rawResponseMaxBytes?: number;
  readonly onDegraded?: (failure: ObservationFailure) => void;
}

export class TraceObservationPort implements ObservationPort {
  private readonly now: () => string;
  private readonly createTraceId: () => string;
  private readonly createAttemptId: () => string;
  private readonly writes: TraceWriteQueue;
  private readonly handles: TraceHandleContext;

  constructor(private readonly options: TraceObservationPortOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createTraceId = options.traceId ?? (() => `trace_${randomUUID()}`);
    this.createAttemptId = options.attemptId ?? (() => `attempt_${randomUUID()}`);
    const rawResponseMaxBytes = options.rawResponseMaxBytes ?? DEFAULT_RAW_RESPONSE_MAX_BYTES;
    if (!Number.isSafeInteger(rawResponseMaxBytes) || rawResponseMaxBytes < 0) {
      throw new Error("rawResponseMaxBytes must be a non-negative safe integer");
    }
    this.writes = new TraceWriteQueue((failure) => this.degraded(failure));
    this.handles = {
      rawResponseMaxBytes,
      schedule: (operation, action) => this.writes.schedule(operation, action),
    };
  }

  startTurn(scope: TurnObservationScope): TurnObservation {
    const manifest: TraceManifest = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: this.createTraceId(),
      conversationId: scope.conversationId,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      capturedAt: this.now(),
      provider: this.options.provider,
      model: this.options.model,
    };
    const writer = TraceBundleWriter.create({ tracesRoot: this.options.tracesRoot, manifest, now: this.now });
    return createTraceTurnObservation(this.handles, writer, scope, this.createAttemptId);
  }

  degraded(failure: ObservationFailure): void {
    try {
      this.options.onDegraded?.(failure);
    } catch {
      // Reporting diagnostic degradation is itself diagnostic and cannot escape.
    }
  }

  async flush(): Promise<void> {
    await this.writes.flush();
  }
}
