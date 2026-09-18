import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableRecordTypes,
  formatApprovalId,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { ProviderHistoryItemTypes, reduceProviderHistory } from "@turnturn/protocol/provider-history";
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

test("trace reduction preserves tool provenance, bounded output, approvals, and later model visibility", async () => {
  await withRoot(async (root) => {
    const ids = scope(9);
    const firstStepId = formatStepId(uuid(91));
    const secondStepId = formatStepId(uuid(92));
    const toolCallId = formatToolCallId(uuid(93));
    const approvalId = formatApprovalId(uuid(94));
    const requestRecordId = formatRecordId(uuid(95));
    const resultRecordId = formatRecordId(uuid(96));
    const observation = new TraceObservationPort({
      tracesRoot: root,
      provider: "test-provider",
      model: "test-model",
      toolOutputMaxBytes: 5,
      traceId: () => "trace_tool_provenance",
      attemptId: (() => {
        let attempt = 0;
        return () => `attempt_${++attempt}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const turn = observation.startTurn(ids);
    const firstStep = turn.startStep({ ...ids, stepId: firstStepId });
    const firstAttempt = firstStep.startProviderAttempt({ provider: "test-provider", model: "test-model" });
    firstAttempt.providerEvent({
      type: "tool-call-complete",
      call: { callId: "provider-call-1", name: "probe", input: { value: 1 } },
    });
    firstAttempt.complete({ reason: "tool-use" });
    firstStep.complete({ reason: "tool-use" });

    const toolScope = { ...ids, stepId: firstStepId, toolCallId, providerToolCallId: "provider-call-1" };
    turn.observeTool({
      type: "validation-input",
      scope: toolScope,
      phase: "provider",
      name: "probe",
      input: { value: 1 },
    });
    turn.observeTool({
      type: "validation-result",
      scope: toolScope,
      phase: "provider",
      result: { ok: true, input: { value: 1 } },
    });
    turn.observeTool({ type: "policy-decision", scope: toolScope, decision: { kind: "ask", reason: "confirm" } });
    turn.observeApproval({ type: "requested", scope: { ...toolScope, approvalId }, reason: "confirm" });
    turn.observeApproval({ type: "resolved", scope: { ...toolScope, approvalId }, decision: "allow" });
    turn.observeTool({ type: "execution-started", scope: toolScope, name: "probe", input: { value: 1 } });
    turn.observeTool({ type: "execution-output", scope: toolScope, stream: "stdout", text: "abc" });
    turn.observeTool({ type: "execution-output", scope: toolScope, stream: "stdout", text: "def" });
    turn.observeTool({ type: "execution-output", scope: toolScope, stream: "stdout", text: "ignored" });
    turn.observeTool({
      type: "execution-finished",
      scope: toolScope,
      outcome: { kind: "completed", output: { ok: true } },
    });
    turn.observeTool({
      type: "result-recorded",
      scope: toolScope,
      result: { status: "completed", output: { ok: true } },
    });

    await observation.flush();
    const beforeLaterRequest = reduceTraceBundle(await readTraceBundle(join(root, "trace_tool_provenance")));
    assert.equal(
      beforeLaterRequest.provenanceLinks.some((link) => link.type.startsWith("request-included")),
      false,
    );

    const secondStep = turn.startStep({ ...ids, stepId: secondStepId });
    secondStep.modelContext({
      history: {
        items: [
          {
            type: ProviderHistoryItemTypes.ToolRequest,
            recordId: requestRecordId,
            sequence: 1,
            turnId: ids.turnId,
            stepId: firstStepId,
            toolCallId,
            name: "probe",
            input: { value: 1 },
            providerOrder: 0,
            requiresApproval: true,
            providerToolCallId: "provider-call-1",
          },
          {
            type: ProviderHistoryItemTypes.ToolResult,
            recordId: resultRecordId,
            sequence: 2,
            turnId: ids.turnId,
            toolCallId,
            status: "completed",
            output: { ok: true },
            synthetic: false,
          },
        ],
        issues: [],
        lastSequence: 2,
      },
      tools: [],
      catalog: {
        contributions: [
          {
            id: "tool-interactions:step-2",
            kind: "tool-interactions",
            scope: "step",
            source: { kind: "durable-provider-history" },
            content: [{ requestRecordId }, { resultRecordId }],
            estimatedTokens: 8,
          },
        ],
      },
      selections: [{ contributionId: "tool-interactions:step-2", disposition: "included", order: 0 }],
    });
    const secondAttempt = secondStep.startProviderAttempt({ provider: "test-provider", model: "test-model" });
    secondAttempt.complete({ reason: "complete", usage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 } });
    secondStep.complete({ reason: "complete" });
    turn.complete({ reason: "complete" });
    await observation.flush();

    const reduced = reduceTraceBundle(await readTraceBundle(join(root, "trace_tool_provenance")));
    const stored = await readTraceBundle(join(root, "trace_tool_provenance"));
    assert.ok(stored.envelopes.every((envelope) => !("payload" in envelope.scope) && !("commandId" in envelope.scope)));
    assert.deepEqual(
      reduced.tools[0].observations.map((event) => event.type),
      [
        "validation-input",
        "validation-result",
        "policy-decision",
        "execution-started",
        "execution-output",
        "execution-output-truncated",
        "execution-finished",
        "result-recorded",
      ],
    );
    assert.equal(reduced.tools[0].providerToolCallId, "provider-call-1");
    assert.deepEqual(
      reduced.approvals[0].observations.map((event) => event.type),
      ["requested", "resolved"],
    );
    assert.deepEqual(
      reduced.provenanceLinks.map((link) => link.type),
      [
        "attempt-produced-tool-call",
        "tool-produced-result",
        "request-included-tool-call",
        "request-included-tool-result",
      ],
    );
    assert.deepEqual(
      reduced.steps.find((step) => step.stepId === secondStepId).context.messages.map((message) => message.historyType),
      ["tool.request", "tool.result"],
    );
    assert.equal(
      reduced.steps.find((step) => step.stepId === secondStepId).context.contributions[0].estimatedTokens,
      8,
    );
    assert.deepEqual(reduced.attempts.find((attempt) => attempt.stepId === secondStepId).completion.usage, {
      inputTokens: 21,
      outputTokens: 3,
      totalTokens: 24,
    });
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
