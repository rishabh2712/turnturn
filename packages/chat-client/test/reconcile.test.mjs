import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalDecisions, LiveEventTypes as Live } from "@turnturn/protocol";
import { ingestLive, ingestRecord, reconcileLive } from "../dist/reconcile.js";
import { Durable, sessionFixture } from "./fixtures.mjs";

// One test per row of the supersession table in reconcile.ts, exercised directly
// against reconcileLive/ingestLive rather than indirectly through the projector.

test("assistant-text-superseded-by-durable-message: a content delta is dropped once its step's message lands", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  const delta = f.event(Live.ContentDelta, { text: "partial" }, { turnId: f.turnId, stepId: f.stepId });
  const withLive = ingestLive(f.slice(), delta);
  assert.deepEqual(withLive.live, [delta]);

  await f.add(Durable.AssistantMessageCompleted, { content: "Full" }, { turnId: f.turnId, stepId: f.stepId });
  const reconciled = reconcileLive(f.slice({ live: [delta] }));
  assert.deepEqual(reconciled.live, []);
});

test("assistant-text-superseded-by-durable-message: a reasoning delta follows the same rule as content", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.AssistantMessageCompleted, { content: "Full" }, { turnId: f.turnId, stepId: f.stepId });
  const delta = f.event(Live.ReasoningDelta, { text: "thinking" }, { turnId: f.turnId, stepId: f.stepId });
  const reconciled = reconcileLive(f.slice({ live: [delta] }));
  assert.deepEqual(reconciled.live, []);
});

test("assistant-text-superseded-by-durable-message: a terminal turn drops late text and raises live-text-unbacked", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  await f.add(
    Durable.TurnFailed,
    { error: { code: "X", message: "x", retryable: false, fatal: true } },
    { turnId: f.turnId },
  );
  const delta = f.event(Live.ContentDelta, { text: "late" }, { turnId: f.turnId, stepId: f.stepId });
  const reconciled = reconcileLive(f.slice({ live: [delta] }));
  assert.deepEqual(reconciled.live, []);
  assert.ok(reconciled.diagnostics.some((issue) => issue.code === "live-text-unbacked" && issue.turnId === f.turnId));
});

test("assistant-text-superseded-by-durable-message: an empty terminal delta is dropped silently", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.add(Durable.TurnAborted, { reason: "stop" }, { turnId: f.turnId });
  const delta = f.event(Live.ContentDelta, { text: "" }, { turnId: f.turnId, stepId: f.stepId });
  const reconciled = reconcileLive(f.slice({ live: [delta] }));
  assert.deepEqual(reconciled.live, []);
  assert.equal(
    reconciled.diagnostics.some((issue) => issue.code === "live-text-unbacked"),
    false,
  );
});

test("tool-activity-superseded-by-terminal-result: a ToolStarted is dropped once the tool result lands", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  await f.startTurn();
  await f.startStep();
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: false },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(
    Durable.ToolResultCompleted,
    { output: { stdout: "/", stderr: "", exitCode: 0 } },
    { turnId: f.turnId, toolCallId },
  );
  const started = f.event(Live.ToolStarted, { name: "shell" }, { turnId: f.turnId, toolCallId });
  const reconciled = reconcileLive(f.slice({ live: [started] }));
  assert.deepEqual(reconciled.live, []);
});

test("approval-request-superseded-by-durable-request: a live approval.requested is dropped once durable", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  const approvalId = f.approvalId();
  await f.startTurn();
  await f.startStep();
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(Durable.ApprovalRequested, { reason: "Run?" }, { turnId: f.turnId, toolCallId, approvalId });
  const live = f.event(Live.ApprovalRequested, { reason: "Run?" }, { turnId: f.turnId, toolCallId, approvalId });
  const reconciled = reconcileLive(f.slice({ live: [live] }));
  assert.deepEqual(reconciled.live, []);
});

test("approval-resolution-superseded-by-durable-resolution: a live approval.resolved is dropped once durable", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  const approvalId = f.approvalId();
  await f.startTurn();
  await f.startStep();
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(Durable.ApprovalRequested, { reason: "Run?" }, { turnId: f.turnId, toolCallId, approvalId });
  await f.add(
    Durable.ApprovalResolved,
    { decision: ApprovalDecisions.Allow },
    { turnId: f.turnId, toolCallId, approvalId },
  );
  const live = f.event(
    Live.ApprovalResolved,
    { decision: ApprovalDecisions.Allow },
    { turnId: f.turnId, toolCallId, approvalId },
  );
  const reconciled = reconcileLive(f.slice({ live: [live] }));
  assert.deepEqual(reconciled.live, []);
});

test("turn-start-superseded-by-durable-start: a live turn.started is dropped once durable", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  const live = f.event(Live.TurnStarted, {}, { turnId: f.turnId });
  const reconciled = reconcileLive(f.slice({ live: [live] }));
  assert.deepEqual(reconciled.live, []);
});

test("turn-terminal-superseded-by-durable-terminal: a live turn.completed is dropped once durable", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.add(Durable.TurnCompleted, {}, { turnId: f.turnId });
  const live = f.event(Live.TurnCompleted, {}, { turnId: f.turnId });
  const reconciled = reconcileLive(f.slice({ live: [live] }));
  assert.deepEqual(reconciled.live, []);
});

test("an event with no matching rule and no durable fact backing it is retained", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  const live = f.event(Live.ProviderRaw, { value: null }, { turnId: f.turnId });
  const reconciled = reconcileLive(f.slice({ live: [live] }));
  assert.deepEqual(reconciled.live, [live]);
});

test("ingestLive rejects a live event scoped to another session", async (t) => {
  const a = await sessionFixture(t);
  const b = await sessionFixture(t, { conversationId: a.conversationId });
  const foreign = b.event(Live.TurnStarted, {}, { turnId: b.turnId });
  const next = ingestLive(a.slice(), foreign);
  assert.deepEqual(next.live, []);
  assert.equal(next.diagnostics.at(-1).code, "foreign-live-event");
});

test("ingestLive is idempotent on redelivery of the same eventId", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  const live = f.event(Live.TurnStarted, {}, { turnId: f.turnId });
  const once = ingestLive(f.slice(), live);
  const twice = ingestLive(once, live);
  assert.deepEqual(twice.live, once.live);
});

test("more than 50 warnings retains only the most recent 50", async (t) => {
  const f = await sessionFixture(t);
  const warnings = Array.from({ length: 60 }, (_, index) =>
    f.event(Live.Warning, { message: `warning ${index}`, code: "W" }),
  );
  const reconciled = reconcileLive(f.slice({ live: warnings }));
  assert.equal(reconciled.live.length, 50);
  assert.deepEqual(
    reconciled.live.map((event) => event.payload.message),
    warnings.slice(10).map((event) => event.payload.message),
  );
});

test("ingestRecord rejects a record scoped to another session", async (t) => {
  const a = await sessionFixture(t);
  const b = await sessionFixture(t, { conversationId: a.conversationId });
  const next = ingestRecord(a.slice(), b.records[0]);
  assert.deepEqual(next.records, a.slice().records);
  assert.equal(next.diagnostics.at(-1).code, "foreign-session");
});

test("ingestRecord flags a genuine sequence conflict rather than accepting either record", async (t) => {
  const f = await sessionFixture(t);
  const original = f.slice({ records: f.records.slice(0, 1), lastSequence: 1 });
  const conflicting = { ...f.records[1], sequence: 1 };
  const next = ingestRecord(original, conflicting);
  assert.deepEqual(next.records, original.records);
  assert.equal(next.diagnostics.at(-1).code, "sequence-conflict");
});
