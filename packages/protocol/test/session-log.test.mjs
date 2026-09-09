import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableRecordTypes,
  serializeJson
} from "../dist/index.js";
import {
  DuplicateRecordError,
  JsonlSessionLogWriter,
  readSessionLog,
  SessionLogIssueCodes
} from "../dist/session-log.js";
import { durableFixtures } from "../dist/fixtures.js";

async function withTempLog(fn) {
  const dir = await mkdtemp(join(tmpdir(), "turnturn-protocol-"));
  try {
    await fn(join(dir, "session.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const toDraft = record => {
  const { sequence, ...draft } = record;
  return draft;
};

test("writer assigns monotonic durable sequence numbers", async () => withTempLog(async path => {
  const writer = await JsonlSessionLogWriter.open(path);
  const first = await writer.append(toDraft(durableFixtures[0]));
  const second = await writer.append(toDraft(durableFixtures[1]));

  assert.equal(first.appended, true);
  assert.equal(first.record.sequence, 1);
  assert.equal(second.record.sequence, 2);
  assert.equal(writer.nextSequence, 3);

  const loaded = await readSessionLog(path);
  assert.deepEqual(loaded.records, [first.record, second.record]);
  assert.equal(loaded.nextSequence, 3);
  assert.deepEqual(loaded.issues, []);
}));

test("duplicate recordId is idempotent only when persisted bytes match", async () => withTempLog(async path => {
  const writer = await JsonlSessionLogWriter.open(path);
  const draft = toDraft(durableFixtures[0]);
  const first = await writer.append(draft);
  const duplicate = await writer.append(draft);

  assert.equal(duplicate.appended, false);
  assert.deepEqual(duplicate.record, first.record);

  await assert.rejects(
    () => writer.append({ ...draft, payload: { title: "Different" } }),
    DuplicateRecordError
  );
}));

test("writer resumes sequence after existing log", async () => withTempLog(async path => {
  const writer = await JsonlSessionLogWriter.open(path);
  await writer.append(toDraft(durableFixtures[0]));

  const resumed = await JsonlSessionLogWriter.open(path);
  assert.equal(resumed.nextSequence, 2);
  const appended = await resumed.append(toDraft(durableFixtures[1]));
  assert.equal(appended.record.sequence, 2);
}));

test("reader reports and skips only a corrupt trailing record", async () => withTempLog(async path => {
  const first = { ...durableFixtures[0], sequence: 1 };
  await writeFile(path, `${serializeJson(first)}\n{"schemaVersion":`, "utf8");

  const result = await readSessionLog(path);
  assert.deepEqual(result.records, [first]);
  assert.equal(result.recoveredCorruptTail, true);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.InvalidJson);
  assert.equal(result.nextSequence, 2);
}));

test("reader rejects corrupt middle records instead of treating them as recoverable tail", async () => withTempLog(async path => {
  const first = { ...durableFixtures[0], sequence: 1 };
  const second = { ...durableFixtures[1], sequence: 2 };
  await writeFile(path, `${serializeJson(first)}\nnot-json\n${serializeJson(second)}\n`, "utf8");

  const result = await readSessionLog(path);
  assert.deepEqual(result.records, [first]);
  assert.equal(result.recoveredCorruptTail, false);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.InvalidJson);
}));

test("reader validates required metadata with zod", async () => withTempLog(async path => {
  const invalid = { ...durableFixtures[0] };
  delete invalid.sessionId;
  await writeFile(path, `${JSON.stringify(invalid)}\n`, "utf8");

  const result = await readSessionLog(path);
  assert.equal(result.records.length, 0);
  assert.equal(result.recoveredCorruptTail, false);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.InvalidMetadata);
  assert.match(result.issues[0].message, /sessionId/);
}));

test("reader enforces monotonic sequence and top-level protocol shape", async () => withTempLog(async path => {
  const first = { ...durableFixtures[0], sequence: 2 };
  await writeFile(path, `${JSON.stringify({ ...first, extra: true })}\n`, "utf8");

  const result = await readSessionLog(path);
  assert.equal(result.records.length, 0);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.InvalidMetadata);
}));

test("reader enforces type-specific scope", async () => withTempLog(async path => {
  const invalid = { ...durableFixtures.find(record => record.type === DurableRecordTypes.ToolRequested), sequence: 1 };
  delete invalid.toolCallId;
  await writeFile(path, `${JSON.stringify(invalid)}\n`, "utf8");

  const result = await readSessionLog(path);
  assert.equal(result.records.length, 0);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.InvalidMetadata);
  assert.match(result.issues[0].message, /toolCallId/);
}));

test("allowMissing lets a writer open a new log", async () => withTempLog(async path => {
  const result = await readSessionLog(path, { allowMissing: true });
  assert.equal(result.nextSequence, 1);
  assert.equal(result.issues[0].code, SessionLogIssueCodes.MissingFile);

  const writer = await JsonlSessionLogWriter.open(path);
  await writer.append(toDraft(durableFixtures[0]));
  const text = await readFile(path, "utf8");
  assert.match(text, /"conversation.created"/);
}));
