import assert from "node:assert/strict";
import test from "node:test";
import { TraceInspectorController } from "../dist/index.js";

const selection = { conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_1" };

function trace(traceId, marker) {
  return {
    traceId,
    turns: [{ turnId: "turn_1", status: "completed" }],
    steps: [],
    attempts: [],
    tools: [],
    approvals: [],
    provenanceLinks: [],
    payloadReferences: [],
    issues: [{ marker }],
  };
}

test("a slower previous selection cannot overwrite the newly selected trace", async () => {
  const releases = new Map();
  const transport = {
    listTraces: (_conversationId, _sessionId, turnId) =>
      new Promise((resolve) => releases.set(turnId, () => resolve({ traces: [summary(`trace_${turnId}`, turnId)] }))),
    getTrace: async (_conversationId, _sessionId, traceId) => ({
      traceId,
      lastTraceSequence: 1,
      unchanged: false,
      trace: trace(traceId, traceId),
    }),
  };
  const controller = new TraceInspectorController(transport);
  const first = controller.open(selection);
  const secondSelection = { ...selection, turnId: "turn_2" };
  const second = controller.open(secondSelection);
  releases.get("turn_2")();
  await second;
  releases.get("turn_1")();
  await first;
  assert.equal(controller.getSnapshot().summary.traceId, "trace_turn_2");
});

test("payload requests are cached and a missing trace is isolated as inspector state", async () => {
  let payloadReads = 0;
  const transport = {
    listTraces: async () => ({ traces: [summary("trace_1", "turn_1")] }),
    getTrace: async () => ({ traceId: "trace_1", lastTraceSequence: 1, unchanged: false, trace: trace("trace_1") }),
    getTracePayload: async () => {
      payloadReads += 1;
      return { payloadId: "payload_1", value: { exact: true } };
    },
  };
  const controller = new TraceInspectorController(transport);
  await controller.open(selection);
  const [first, second] = await Promise.all([controller.payload("payload_1"), controller.payload("payload_1")]);
  assert.deepEqual(first, { exact: true });
  assert.deepEqual(second, first);
  assert.equal(payloadReads, 1);

  transport.listTraces = async () => ({ traces: [] });
  await controller.open(selection);
  assert.equal(controller.getSnapshot().status, "missing");
});

test("refresh replaces the reduced snapshot only when its trace sequence grows", async () => {
  let lastSequence = 2;
  const transport = {
    listTraces: async () => ({ traces: [summary("trace_1", "turn_1")] }),
    getTrace: async (_conversationId, _sessionId, traceId, after) => {
      if (after === lastSequence) return { traceId, lastTraceSequence: lastSequence, unchanged: true };
      return {
        traceId,
        lastTraceSequence: lastSequence,
        unchanged: false,
        trace: trace(traceId, lastSequence),
      };
    },
  };
  const controller = new TraceInspectorController(transport);
  await controller.open(selection);
  const original = controller.getSnapshot().trace;
  await controller.refresh();
  assert.equal(controller.getSnapshot().trace, original);
  lastSequence = 3;
  await controller.refresh();
  assert.notEqual(controller.getSnapshot().trace, original);
  assert.equal(controller.getSnapshot().lastTraceSequence, 3);
});

function summary(traceId, turnId) {
  return {
    traceId,
    turnId,
    capturedAt: "2026-09-19T00:00:00.000Z",
    provider: "test",
    model: "test",
    status: "completed",
    lastTraceSequence: 1,
    issueCount: 0,
  };
}
