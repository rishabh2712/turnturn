import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableRecordTypes,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatTurnId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { JsonlSessionLogWriter } from "@turnturn/protocol/session-log";
import {
  deleteTraceBundle,
  readTraceBundle,
  reduceTraceBundle,
  TRACE_SCHEMA_VERSION,
  TraceBundleWriter,
  TraceObservationPort,
  traceRootForSessionLog,
} from "../dist/observability/index.js";

test("concurrent session traces own independent sequences and preserve append invocation order", async () => {
  await withRoot(async (root) => {
    const first = scope(1);
    const second = scope(2);
    const firstWriter = await createWriter(root, first, ["payload_slow", "payload_fast"]);
    const secondWriter = await createWriter(root, second, ["payload_other"]);

    await Promise.all([
      firstWriter.append(
        { type: "step.model-context", scope: { ...first, stepId: formatStepId(uuid(11)) } },
        { marker: "first invocation" },
      ),
      firstWriter.append({ type: "turn.completed", scope: first, data: { reason: "complete" } }),
      secondWriter.append({ type: "turn.started", scope: second, data: { input: "other" } }),
    ]);

    const firstRead = await readTraceBundle(firstWriter.bundlePath);
    const secondRead = await readTraceBundle(secondWriter.bundlePath);
    assert.deepEqual(
      firstRead.envelopes.map((event) => [event.traceSequence, event.type]),
      [
        [1, "step.model-context"],
        [2, "turn.completed"],
      ],
    );
    assert.deepEqual(
      secondRead.envelopes.map((event) => event.traceSequence),
      [1],
    );
    const payloadRef = firstRead.envelopes[0].payloadRef;
    assert.ok(payloadRef);
    assert.deepEqual(
      JSON.parse(await readFile(join(firstWriter.bundlePath, "payloads", `${payloadRef}.json`), "utf8")),
      {
        marker: "first invocation",
      },
    );
  });
});

test("trace replay is deterministic and keeps the first terminal attempt outcome", async () => {
  await withRoot(async (root) => {
    const ids = scope(3);
    const stepId = formatStepId(uuid(31));
    const writer = await createWriter(root, ids);
    await writer.append({ type: "turn.started", scope: ids });
    await writer.append({ type: "step.started", scope: { ...ids, stepId } });
    await writer.append({ type: "attempt.started", scope: { ...ids, stepId, attemptId: "attempt_1" } });
    await writer.append({ type: "attempt.completed", scope: { ...ids, stepId, attemptId: "attempt_1" } });
    await writer.append({ type: "attempt.failed", scope: { ...ids, stepId, attemptId: "attempt_1" } });
    await writer.append({ type: "turn.completed", scope: ids });

    const read = await readTraceBundle(writer.bundlePath);
    const first = reduceTraceBundle(read);
    const second = reduceTraceBundle(await readTraceBundle(writer.bundlePath));
    assert.deepEqual(second, first);
    assert.equal(first.turns[0].status, "completed");
    assert.equal(first.steps[0].status, "running");
    assert.equal(first.attempts[0].status, "completed");
    assert.deepEqual(
      first.issues.filter((issue) => issue.code === "duplicate_terminal").map((issue) => issue.traceSequence),
      [5],
    );
  });
});

test("a referenced payload is durable before its trace envelope is appended", async () => {
  await withRoot(async (root) => {
    const ids = scope(7);
    const writer = await createWriter(root, ids, ["payload_before_event"]);
    await mkdir(join(writer.bundlePath, "trace.jsonl"));

    await assert.rejects(writer.append({ type: "turn.started", scope: ids }, { request: "large request body" }));

    assert.deepEqual(await readdir(join(writer.bundlePath, "payloads")), ["payload_before_event.json"]);
  });
});

test("reader reports sequence gaps, missing payloads, and a recoverable torn tail", async () => {
  await withRoot(async (root) => {
    const ids = scope(4);
    const writer = await createWriter(root, ids);
    await writer.append({ type: "turn.started", scope: ids });
    await appendFile(
      join(writer.bundlePath, "trace.jsonl"),
      `${JSON.stringify({
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceSequence: 3,
        observedAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        scope: ids,
        payloadRef: "payload_missing",
      })}\n{"traceSequence":`,
    );

    const read = await readTraceBundle(writer.bundlePath);
    assert.equal(read.recoveredTornTail, true);
    assert.deepEqual(
      read.issues.map((issue) => issue.code),
      ["sequence_gap", "missing_payload", "torn_tail"],
    );
    assert.deepEqual(
      read.envelopes.map((event) => event.traceSequence),
      [1, 3],
    );
  });
});

test("deleting a trace bundle cannot change durable replay", async () => {
  await withRoot(async (root) => {
    const ids = scope(5);
    const sessionLog = join(root, `000001-${ids.sessionId}.jsonl`);
    const durable = await JsonlSessionLogWriter.open(sessionLog);
    await durable.append(durableRecord(DurableRecordTypes.ConversationCreated, ids));
    await durable.append(durableRecord(DurableRecordTypes.SessionCreated, ids));
    const traceRoot = traceRootForSessionLog(sessionLog);
    const writer = await createWriter(traceRoot, ids);
    await writer.append({ type: "turn.started", scope: ids }, { secret: "diagnostic only" });
    const durableBytes = await readFile(sessionLog, "utf8");
    const durableRecords = (await import("@turnturn/protocol/session-log")).readSessionLog;
    const before = await durableRecords(sessionLog);

    await deleteTraceBundle(writer.bundlePath);

    const after = await durableRecords(sessionLog);
    assert.equal(await readFile(sessionLog, "utf8"), durableBytes);
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(reduceEngineState(after.records).issues, []);
    assert.deepEqual(reduceProviderHistory(after.records).issues, []);
  });
});

test("reader rejects a manifest whose identity disagrees with an event", async () => {
  await withRoot(async (root) => {
    const ids = scope(6);
    const writer = await createWriter(root, ids);
    await assert.rejects(
      writer.append({ type: "turn.started", scope: { ...ids, sessionId: formatSessionId(uuid(99)) } }),
      /manifest scope/,
    );
    await appendFile(
      join(writer.bundlePath, "trace.jsonl"),
      `${JSON.stringify({
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceSequence: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        type: "turn.started",
        scope: { ...ids, sessionId: formatSessionId(uuid(99)) },
      })}\n`,
    );
    const read = await readTraceBundle(writer.bundlePath);
    assert.deepEqual(
      read.issues.map((issue) => issue.code),
      ["scope_mismatch"],
    );
  });
});

test("raw response capture emits one truncation issue and preserves semantic events", async () => {
  await withRoot(async (root) => {
    const ids = scope(8);
    const stepId = formatStepId(uuid(81));
    const observation = new TraceObservationPort({
      tracesRoot: root,
      provider: "test-provider",
      model: "test-model",
      rawResponseMaxBytes: 5,
      traceId: () => "trace_bounded",
      attemptId: () => "attempt_bounded",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const turn = observation.startTurn(ids);
    const step = turn.startStep({ ...ids, stepId });
    const attempt = step.startProviderAttempt({ provider: "test-provider", model: "test-model" });

    attempt.rawResponseFrame({ data: "abc" });
    attempt.rawResponseFrame({ data: "def" });
    attempt.rawResponseFrame({ data: "ignored" });
    attempt.providerEvent({ type: "text-delta", text: "semantic evidence survives" });
    attempt.complete({ reason: "complete" });
    step.complete({ reason: "complete" });
    turn.complete({ reason: "complete" });
    await observation.flush();

    const bundle = await readTraceBundle(join(root, "trace_bounded"));
    assert.deepEqual(bundle.issues, []);
    assert.deepEqual(
      bundle.envelopes.map((event) => event.type),
      [
        "turn.started",
        "step.started",
        "attempt.started",
        "attempt.raw-response-frame",
        "attempt.issue",
        "attempt.provider-event",
        "attempt.completed",
        "step.completed",
        "turn.completed",
      ],
    );
    const issue = bundle.envelopes.find((event) => event.type === "attempt.issue");
    assert.deepEqual(issue.data, { kind: "payload-truncated", boundBytes: 5 });
    const raw = bundle.envelopes.find((event) => event.type === "attempt.raw-response-frame");
    assert.ok(raw.payloadRef);
    assert.equal(
      JSON.parse(await readFile(join(bundle.bundlePath, "payloads", `${raw.payloadRef}.json`), "utf8")),
      "abc",
    );
    const reduced = reduceTraceBundle(bundle);
    assert.deepEqual(
      reduced.attempts[0].stream.map((item) => item.kind),
      ["raw-response-frame", "issue", "provider-event"],
    );
    assert.deepEqual(
      reduced.attempts[0].stream.map((item) => item.traceSequence),
      [4, 5, 6],
    );
    assert.equal(reduced.attempts[0].stream[0].payloadRef, raw.payloadRef);
  });
});

async function createWriter(root, ids, payloadIds = []) {
  let index = 0;
  return TraceBundleWriter.create({
    tracesRoot: root,
    manifest: {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: `trace_${ids.turnId}`,
      conversationId: ids.conversationId,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      capturedAt: "2026-01-01T00:00:00.000Z",
      provider: "test-provider",
      model: "test-model",
    },
    now: () => "2026-01-01T00:00:00.000Z",
    payloadId: () => payloadIds[index++] ?? `payload_${index}`,
  });
}

function scope(index) {
  return {
    conversationId: formatConversationId(uuid(index * 10 + 1)),
    sessionId: formatSessionId(uuid(index * 10 + 2)),
    turnId: formatTurnId(uuid(index * 10 + 3)),
  };
}

function durableRecord(type, ids) {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: formatRecordId(randomUUID()),
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    payload: {},
  };
}

function uuid(n) {
  return `018f1f4e-8d5f-7abc-8123-823456789${String(n).padStart(3, "0")}`;
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "turnturn-trace-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
