import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type JsonValue, serializeJson } from "@turnturn/protocol";
import { TRACE_SCHEMA_VERSION, type TraceEnvelope, type TraceEventDraft, type TraceManifest } from "./trace-types.js";

export interface CreateTraceBundleOptions {
  readonly tracesRoot: string;
  readonly manifest: TraceManifest;
  readonly now?: () => string;
  readonly payloadId?: () => string;
}

export class TraceBundleWriter {
  private nextSequence = 1;
  private appendChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly bundlePath: string,
    readonly manifest: TraceManifest,
    private readonly now: () => string,
    private readonly createPayloadId: () => string,
  ) {}

  static async create(options: CreateTraceBundleOptions): Promise<TraceBundleWriter> {
    validateManifestForWrite(options.manifest);
    await mkdir(options.tracesRoot, { recursive: true });
    const bundlePath = join(options.tracesRoot, options.manifest.traceId);
    await mkdir(bundlePath);
    await mkdir(join(bundlePath, "payloads"));
    await writeFile(join(bundlePath, "manifest.json"), `${serializeJson(options.manifest)}\n`, { flag: "wx" });
    return new TraceBundleWriter(
      bundlePath,
      options.manifest,
      options.now ?? (() => new Date().toISOString()),
      options.payloadId ?? (() => `payload_${randomUUID()}`),
    );
  }

  append(event: TraceEventDraft, largePayload?: JsonValue): Promise<TraceEnvelope> {
    let stored!: TraceEnvelope;
    const operation = this.appendChain.then(async () => {
      validateEventForWrite(event, this.manifest);
      const payloadRef = largePayload === undefined ? undefined : await this.writePayload(largePayload);
      const envelope: TraceEnvelope = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceSequence: this.nextSequence,
        observedAt: this.now(),
        ...event,
        ...(payloadRef === undefined ? {} : { payloadRef }),
      };
      await appendFile(join(this.bundlePath, "trace.jsonl"), `${serializeJson(envelope)}\n`, "utf8");
      this.nextSequence += 1;
      stored = envelope;
    });
    this.appendChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then(() => stored);
  }

  private async writePayload(payload: JsonValue): Promise<string> {
    const payloadRef = this.createPayloadId();
    validatePathSegment(payloadRef, "payload ID");
    const payloadDir = join(this.bundlePath, "payloads");
    const finalPath = join(payloadDir, `${payloadRef}.json`);
    const temporaryPath = join(payloadDir, `.${payloadRef}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${serializeJson(payload)}\n`, { flag: "wx" });
    await rename(temporaryPath, finalPath);
    return payloadRef;
  }
}

function validateEventForWrite(event: TraceEventDraft, manifest: TraceManifest): void {
  if (
    event.scope.conversationId !== manifest.conversationId ||
    event.scope.sessionId !== manifest.sessionId ||
    event.scope.turnId !== manifest.turnId
  ) {
    throw new Error("Trace event does not belong to its manifest scope");
  }
  if (event.type.startsWith("step.") && event.scope.stepId === undefined) {
    throw new Error("Step trace event requires stepId");
  }
  if (event.type.startsWith("attempt.") && (event.scope.stepId === undefined || event.scope.attemptId === undefined)) {
    throw new Error("Attempt trace event requires stepId and attemptId");
  }
  if (event.type === "tool.observed" && event.scope.toolCallId === undefined) {
    throw new Error("Tool trace event requires toolCallId");
  }
  if (event.type === "approval.observed" && event.scope.approvalId === undefined) {
    throw new Error("Approval trace event requires approvalId");
  }
}

export function traceRootForSessionLog(sessionLogPath: string): string {
  return sessionLogPath.endsWith(".jsonl")
    ? `${sessionLogPath.slice(0, -".jsonl".length)}.traces`
    : `${sessionLogPath}.traces`;
}

function validateManifestForWrite(manifest: TraceManifest): void {
  if (manifest.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error("Unsupported trace schema version");
  validatePathSegment(manifest.traceId, "trace ID");
  if (manifest.capturedAt.length === 0 || manifest.provider.length === 0 || manifest.model.length === 0) {
    throw new Error("Trace manifest metadata must not be empty");
  }
}

function validatePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}`);
  }
}
