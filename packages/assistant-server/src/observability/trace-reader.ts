import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type JsonValue, parseId } from "@turnturn/protocol";
import {
  type ReadTraceBundleResult,
  TRACE_SCHEMA_VERSION,
  type TraceEnvelope,
  type TraceEventType,
  type TraceIssue,
  type TraceManifest,
  type TraceScope,
} from "./trace-types.js";

const eventTypes = new Set<TraceEventType>([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "step.started",
  "step.model-context",
  "step.completed",
  "step.failed",
  "step.cancelled",
  "attempt.started",
  "attempt.wire-request",
  "attempt.response-metadata",
  "attempt.raw-response-frame",
  "attempt.provider-event",
  "attempt.completed",
  "attempt.failed",
  "attempt.cancelled",
  "attempt.issue",
  "tool.observed",
  "approval.observed",
]);

export async function readTraceBundle(bundlePath: string): Promise<ReadTraceBundleResult> {
  const manifest = parseManifest(JSON.parse(await readFile(join(bundlePath, "manifest.json"), "utf8")));
  const issues: TraceIssue[] = [];
  const envelopes: TraceEnvelope[] = [];
  let recoveredTornTail = false;
  let text: string;
  try {
    text = await readFile(join(bundlePath, "trace.jsonl"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return { bundlePath, manifest, envelopes, issues, recoveredTornTail };
    throw error;
  }

  const lines = text.split("\n");
  let expectedSequence = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) break;
    if (rawLine.trim() === "") {
      if (index === lines.length - 1) continue;
      issues.push({ code: "invalid_envelope", line: index + 1, message: "Blank line before end of trace" });
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      const isTail = index === lines.length - 1 || (index === lines.length - 2 && lines[index + 1] === "");
      issues.push({
        code: isTail ? "torn_tail" : "invalid_json",
        line: index + 1,
        message: error instanceof Error ? error.message : "Invalid trace JSON",
      });
      recoveredTornTail = isTail;
      break;
    }

    let envelope: TraceEnvelope;
    try {
      envelope = parseEnvelope(parsed);
    } catch (error) {
      issues.push({
        code: "invalid_envelope",
        line: index + 1,
        message: error instanceof Error ? error.message : "Invalid trace envelope",
      });
      break;
    }
    envelopes.push(envelope);
    if (envelope.traceSequence !== expectedSequence) {
      issues.push({
        code: "sequence_gap",
        line: index + 1,
        traceSequence: envelope.traceSequence,
        message: `Expected trace sequence ${expectedSequence}, got ${envelope.traceSequence}`,
      });
    }
    expectedSequence = envelope.traceSequence + 1;
    if (!scopeMatchesManifest(envelope.scope, manifest)) {
      issues.push({
        code: "scope_mismatch",
        line: index + 1,
        traceSequence: envelope.traceSequence,
        message: "Trace event does not belong to its manifest scope",
      });
    }
    if (envelope.payloadRef !== undefined && !(await payloadExists(bundlePath, envelope.payloadRef))) {
      issues.push({
        code: "missing_payload",
        line: index + 1,
        traceSequence: envelope.traceSequence,
        message: `Missing trace payload: ${envelope.payloadRef}`,
      });
    }
  }

  return { bundlePath, manifest, envelopes, issues, recoveredTornTail };
}

export async function deleteTraceBundle(bundlePath: string): Promise<void> {
  await rm(bundlePath, { recursive: true, force: true });
}

export async function readTracePayload(bundlePath: string, payloadRef: string): Promise<JsonValue> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(payloadRef) || payloadRef === "." || payloadRef === "..") {
    throw new Error("Invalid trace payload ID");
  }
  return JSON.parse(await readFile(join(bundlePath, "payloads", `${payloadRef}.json`), "utf8")) as JsonValue;
}

function parseManifest(value: unknown): TraceManifest {
  const record = objectRecord(value, "Invalid trace manifest");
  if (record.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error("Unsupported trace schema version");
  const traceId = nonEmptyString(record.traceId, "traceId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(traceId)) throw new Error("Invalid traceId");
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceId,
    conversationId: parseId("conv", nonEmptyString(record.conversationId, "conversationId")),
    sessionId: parseId("sess", nonEmptyString(record.sessionId, "sessionId")),
    turnId: parseId("turn", nonEmptyString(record.turnId, "turnId")),
    capturedAt: nonEmptyString(record.capturedAt, "capturedAt"),
    provider: nonEmptyString(record.provider, "provider"),
    model: nonEmptyString(record.model, "model"),
  };
}

function parseEnvelope(value: unknown): TraceEnvelope {
  const record = objectRecord(value, "Invalid trace envelope");
  if (record.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error("Unsupported trace envelope schema version");
  if (!Number.isSafeInteger(record.traceSequence) || Number(record.traceSequence) < 1) {
    throw new Error("traceSequence must be a positive safe integer");
  }
  const type = nonEmptyString(record.type, "type") as TraceEventType;
  if (!eventTypes.has(type)) throw new Error(`Unknown trace event type: ${type}`);
  const scope = parseScope(record.scope);
  validateEventScope(type, scope);
  const payloadRef = record.payloadRef === undefined ? undefined : nonEmptyString(record.payloadRef, "payloadRef");
  if (payloadRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(payloadRef)) {
    throw new Error("Invalid payloadRef");
  }
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceSequence: Number(record.traceSequence),
    observedAt: nonEmptyString(record.observedAt, "observedAt"),
    type,
    scope,
    ...(record.data === undefined ? {} : { data: record.data as JsonValue }),
    ...(payloadRef === undefined ? {} : { payloadRef }),
  } as TraceEnvelope;
}

function validateEventScope(type: TraceEventType, scope: TraceScope): void {
  if (type.startsWith("step.") && scope.stepId === undefined) throw new Error("Step trace event requires stepId");
  if (type.startsWith("attempt.") && (scope.stepId === undefined || scope.attemptId === undefined)) {
    throw new Error("Attempt trace event requires stepId and attemptId");
  }
  if (type === "tool.observed" && (scope.stepId === undefined || scope.toolCallId === undefined)) {
    throw new Error("Tool trace event requires stepId and toolCallId");
  }
  if (
    type === "approval.observed" &&
    (scope.stepId === undefined || scope.toolCallId === undefined || scope.approvalId === undefined)
  ) {
    throw new Error("Approval trace event requires stepId, toolCallId, and approvalId");
  }
}

function parseScope(value: unknown): TraceScope {
  const scope = objectRecord(value, "Invalid trace scope");
  return {
    conversationId: parseId("conv", nonEmptyString(scope.conversationId, "conversationId")),
    sessionId: parseId("sess", nonEmptyString(scope.sessionId, "sessionId")),
    turnId: parseId("turn", nonEmptyString(scope.turnId, "turnId")),
    ...(scope.stepId === undefined ? {} : { stepId: parseId("step", nonEmptyString(scope.stepId, "stepId")) }),
    ...(scope.attemptId === undefined ? {} : { attemptId: nonEmptyString(scope.attemptId, "attemptId") }),
    ...(scope.toolCallId === undefined
      ? {}
      : { toolCallId: parseId("tool", nonEmptyString(scope.toolCallId, "toolCallId")) }),
    ...(scope.providerToolCallId === undefined
      ? {}
      : { providerToolCallId: nonEmptyString(scope.providerToolCallId, "providerToolCallId") }),
    ...(scope.approvalId === undefined
      ? {}
      : { approvalId: parseId("appr", nonEmptyString(scope.approvalId, "approvalId")) }),
  };
}

function scopeMatchesManifest(scope: TraceScope, manifest: TraceManifest): boolean {
  return (
    scope.conversationId === manifest.conversationId &&
    scope.sessionId === manifest.sessionId &&
    scope.turnId === manifest.turnId
  );
}

async function payloadExists(bundlePath: string, payloadRef: string): Promise<boolean> {
  try {
    await readFile(join(bundlePath, "payloads", `${payloadRef}.json`));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
