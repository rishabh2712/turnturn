import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DurableRecordTypes,
  SCHEMA_VERSION,
  parseId,
  serializeJson,
  type DurableRecord,
  type DurableRecordDraft
} from "./index.js";

export enum SessionLogIssueCodes {
  InvalidJson = "invalid_json",
  InvalidMetadata = "invalid_metadata",
  DuplicateRecordId = "duplicate_record_id",
  NonMonotonicSequence = "non_monotonic_sequence",
  MissingFile = "missing_file"
}

export type SessionLogIssueCode = SessionLogIssueCodes;

export interface SessionLogIssue {
  readonly code: SessionLogIssueCode;
  readonly line: number;
  readonly message: string;
}

export interface ReadSessionLogResult {
  readonly records: DurableRecord[];
  readonly issues: SessionLogIssue[];
  readonly nextSequence: number;
  readonly recoveredCorruptTail: boolean;
}

export interface AppendSessionRecordResult {
  readonly record: DurableRecord;
  readonly appended: boolean;
}

const turnScopedTypes = new Set<DurableRecordTypes>([
  DurableRecordTypes.TurnStarted,
  DurableRecordTypes.UserInputAccepted,
  DurableRecordTypes.AssistantMessageCompleted,
  DurableRecordTypes.ProviderStepStarted,
  DurableRecordTypes.ProviderStepCompleted,
  DurableRecordTypes.ProviderStepFailed,
  DurableRecordTypes.ToolRequested,
  DurableRecordTypes.ApprovalRequested,
  DurableRecordTypes.ApprovalResolved,
  DurableRecordTypes.ToolResultCompleted,
  DurableRecordTypes.ToolResultFailed,
  DurableRecordTypes.ToolResultDenied,
  DurableRecordTypes.ToolResultAborted,
  DurableRecordTypes.TurnCompleted,
  DurableRecordTypes.TurnFailed,
  DurableRecordTypes.TurnAborted
]);

const durableTypeValues = Object.values(DurableRecordTypes) as [DurableRecordTypes, ...DurableRecordTypes[]];
const idSchema = <P extends Parameters<typeof parseId>[0]>(prefix: P) =>
  z.string().min(1).refine(value => {
    try {
      parseId(prefix, value);
      return true;
    } catch {
      return false;
    }
  }, `must be a ${prefix}_ ID`);

const durableRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  recordId: idSchema("rec"),
  sequence: z.number().int().positive().safe(),
  type: z.enum(durableTypeValues),
  createdAt: z.string().min(1),
  conversationId: idSchema("conv"),
  sessionId: idSchema("sess"),
  turnId: idSchema("turn").optional(),
  stepId: idSchema("step").optional(),
  toolCallId: idSchema("tool").optional(),
  approvalId: idSchema("appr").optional(),
  commandId: idSchema("cmd").optional(),
  providerRequestId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown())
}).strict().superRefine((record, context) => {
  if (turnScopedTypes.has(record.type) && record.turnId === undefined) {
    context.addIssue({ code: "custom", path: ["turnId"], message: "turnId is required for this durable record type" });
  }
  if (stepScopedTypes.has(record.type) && record.stepId === undefined) {
    context.addIssue({ code: "custom", path: ["stepId"], message: "stepId is required for this durable record type" });
  }
  if (toolScopedTypes.has(record.type) && record.toolCallId === undefined) {
    context.addIssue({ code: "custom", path: ["toolCallId"], message: "toolCallId is required for this durable record type" });
  }
  if (approvalScopedTypes.has(record.type) && record.approvalId === undefined) {
    context.addIssue({ code: "custom", path: ["approvalId"], message: "approvalId is required for this durable record type" });
  }
});
const stepScopedTypes = new Set<DurableRecordTypes>([
  DurableRecordTypes.ProviderStepStarted,
  DurableRecordTypes.ProviderStepCompleted,
  DurableRecordTypes.ProviderStepFailed,
  DurableRecordTypes.ToolRequested
]);
const toolScopedTypes = new Set<DurableRecordTypes>([
  DurableRecordTypes.ToolRequested,
  DurableRecordTypes.ApprovalRequested,
  DurableRecordTypes.ApprovalResolved,
  DurableRecordTypes.ToolResultCompleted,
  DurableRecordTypes.ToolResultFailed,
  DurableRecordTypes.ToolResultDenied,
  DurableRecordTypes.ToolResultAborted
]);
const approvalScopedTypes = new Set<DurableRecordTypes>([
  DurableRecordTypes.ApprovalRequested,
  DurableRecordTypes.ApprovalResolved
]);

export class SessionLogError extends Error {
  constructor(
    message: string,
    readonly issues: readonly SessionLogIssue[]
  ) {
    super(message);
    this.name = "SessionLogError";
  }
}

export class DuplicateRecordError extends SessionLogError {
  constructor(readonly recordId: string) {
    super(`Duplicate recordId with different content: ${recordId}`, [
      { code: SessionLogIssueCodes.DuplicateRecordId, line: 0, message: `Duplicate recordId with different content: ${recordId}` }
    ]);
    this.name = "DuplicateRecordError";
  }
}

export class JsonlSessionLogWriter {
  private constructor(
    private readonly path: string,
    private nextSequenceValue: number,
    private readonly recordsById: Map<string, { readonly record: DurableRecord; readonly line: string }>
  ) {}

  static async open(path: string): Promise<JsonlSessionLogWriter> {
    const result = await readSessionLog(path, { allowMissing: true });
    if (result.issues.some(issue => issue.code !== SessionLogIssueCodes.MissingFile)) {
      throw new SessionLogError("Cannot append to invalid session log", result.issues);
    }
    const recordsById = new Map<string, { readonly record: DurableRecord; readonly line: string }>();
    for (const record of result.records) {
      recordsById.set(record.recordId, { record, line: serializeJson(record) });
    }
    return new JsonlSessionLogWriter(path, result.nextSequence, recordsById);
  }

  get nextSequence(): number {
    return this.nextSequenceValue;
  }

  async append(draft: DurableRecordDraft): Promise<AppendSessionRecordResult> {
    const existing = this.recordsById.get(draft.recordId);
    if (existing) {
      const duplicateLine = serializeJson(validateDurableRecord(assignSequence(draft, existing.record.sequence)));
      if (duplicateLine === existing.line) return { record: existing.record, appended: false };
      throw new DuplicateRecordError(draft.recordId);
    }

    const record = assignSequence(draft, this.nextSequenceValue);
    const line = serializeJson(validateDurableRecord(record));
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${line}\n`, { encoding: "utf8" });
    this.recordsById.set(record.recordId, { record, line });
    this.nextSequenceValue += 1;
    return { record, appended: true };
  }
}

export async function readSessionLog(path: string, options: { readonly allowMissing?: boolean } = {}): Promise<ReadSessionLogResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error) && options.allowMissing) {
      return { records: [], issues: [{ code: SessionLogIssueCodes.MissingFile, line: 0, message: "Session log does not exist" }], nextSequence: 1, recoveredCorruptTail: false };
    }
    throw error;
  }

  const lines = text.split("\n");
  const records: DurableRecord[] = [];
  const issues: SessionLogIssue[] = [];
  const seen = new Map<string, string>();
  let expectedSequence = 1;
  let recoveredCorruptTail = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const lineNumber = index + 1;
    if (rawLine.trim() === "") {
      if (index === lines.length - 1) continue;
      issues.push({ code: SessionLogIssueCodes.InvalidMetadata, line: lineNumber, message: "Blank line before end of log" });
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      issues.push({ code: SessionLogIssueCodes.InvalidJson, line: lineNumber, message: error instanceof Error ? error.message : "Invalid JSON" });
      recoveredCorruptTail = index === lines.length - 1 || (index === lines.length - 2 && lines[index + 1] === "");
      break;
    }

    try {
      const record = validateDurableRecord(parsed);
      if (record.sequence !== expectedSequence) {
        issues.push({ code: SessionLogIssueCodes.NonMonotonicSequence, line: lineNumber, message: `Expected sequence ${expectedSequence}, got ${record.sequence}` });
        break;
      }
      const existingLine = seen.get(record.recordId);
      if (existingLine !== undefined) {
        if (existingLine !== rawLine) {
          issues.push({ code: SessionLogIssueCodes.DuplicateRecordId, line: lineNumber, message: `Duplicate recordId with different content: ${record.recordId}` });
          break;
        }
        continue;
      }
      seen.set(record.recordId, rawLine);
      records.push(record);
      expectedSequence += 1;
    } catch (error) {
      issues.push({ code: SessionLogIssueCodes.InvalidMetadata, line: lineNumber, message: error instanceof Error ? error.message : "Invalid record metadata" });
      break;
    }
  }

  return { records, issues, nextSequence: expectedSequence, recoveredCorruptTail };
}

export function validateDurableRecord(value: unknown): DurableRecord {
  const record = durableRecordSchema.parse(value);
  serializeJson(record);
  return record as DurableRecord;
}

function assignSequence(draft: DurableRecordDraft, sequence: number): DurableRecord {
  const { sequence: _ignored, ...record } = draft as DurableRecordDraft & { readonly sequence?: unknown };
  return { ...record, sequence } as DurableRecord;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
