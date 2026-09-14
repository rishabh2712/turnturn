import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalDecisions, LiveEventTypes as Live } from "@turnturn/protocol";
import { projectConversation } from "../dist/projector.js";
import { ingestRecord } from "../dist/reconcile.js";
import { Durable, sessionFixture } from "./fixtures.mjs";

const failure = { code: "TEST_FAILURE", message: "failed", retryable: true, fatal: false };

function items(view, kind) {
  return view.items.filter((item) => item.kind === kind);
}

test("a foreign-session record is rejected before projection", async (t) => {
  const a = await sessionFixture(t);
  const b = await sessionFixture(t, { conversationId: a.conversationId });
  const original = a.slice();
  const next = ingestRecord(original, b.records[0]);
  assert.deepEqual(next.records, original.records);
  assert.equal(next.diagnostics.at(-1).code, "foreign-session");
});

test("a conversation projection never mixes another conversation's slice", async (t) => {
  const a = await sessionFixture(t);
  const b = await sessionFixture(t);
  await a.startTurn("A only");
  await b.startTurn("B only");
  const view = projectConversation(a.conversationId, [a.slice(), b.slice()]);
  assert.deepEqual(
    items(view, "user-message").map((item) => item.text),
    ["A only"],
  );
  assert.ok(view.diagnostics.some((issue) => issue.code === "foreign-conversation"));
});

test("durable assistant text supersedes streamed text without duplication", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.AssistantMessageCompleted, { content: "Hello" }, { turnId: f.turnId, stepId: f.stepId });
  const delta = f.event(Live.ContentDelta, { text: "Hel" }, { turnId: f.turnId, stepId: f.stepId });
  const view = projectConversation(f.conversationId, [f.slice({ live: [delta] })]);
  assert.deepEqual(
    items(view, "assistant-message").map((item) => [item.text, item.source]),
    [["Hello", "durable"]],
  );
});

test("two provider steps retain separate assistant messages in durable order", async (t) => {
  const f = await sessionFixture(t);
  const second = f.anotherStepId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.AssistantMessageCompleted, { content: "First" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  await f.startStep(second);
  await f.add(Durable.AssistantMessageCompleted, { content: "Second" }, { turnId: f.turnId, stepId: second });
  await f.add(Durable.ProviderStepCompleted, { stopReason: "complete" }, { turnId: f.turnId, stepId: second });
  await f.add(Durable.TurnCompleted, {}, { turnId: f.turnId });
  const view = projectConversation(f.conversationId, [f.slice()]);
  assert.deepEqual(
    items(view, "assistant-message").map((item) => item.text),
    ["First", "Second"],
  );
  assert.deepEqual(
    items(view, "assistant-message").map((item) => item.key),
    [`a:${f.stepId}`, `a:${second}`],
  );
});

test("a terminal turn has one status even when its live terminal is still held", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.add(Durable.TurnCompleted, { stopReason: "complete" }, { turnId: f.turnId });
  const live = f.event(Live.TurnCompleted, {}, { turnId: f.turnId });
  const view = projectConversation(f.conversationId, [f.slice({ live: [live] })]);
  assert.deepEqual(
    items(view, "turn-status").map((item) => item.status),
    ["completed"],
  );
  assert.equal(view.activeTurn, undefined);
});

test("one provider step groups two identical tools without deduplicating them", async (t) => {
  const f = await sessionFixture(t);
  const first = f.toolCallId();
  const second = f.toolCallId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  for (const [toolCallId, providerOrder] of [
    [first, 1],
    [second, 0],
  ]) {
    await f.add(
      Durable.ToolRequested,
      { name: "read", input: { path: "a.ts" }, providerOrder, requiresApproval: false },
      { turnId: f.turnId, stepId: f.stepId, toolCallId },
    );
    await f.add(
      Durable.ToolResultCompleted,
      { output: { path: "a.ts", content: "same" } },
      { turnId: f.turnId, toolCallId },
    );
  }
  const [group] = items(projectConversation(f.conversationId, [f.slice()]), "tool-activity");
  assert.equal(group.key, `t:${f.stepId}`);
  assert.deepEqual(
    group.calls.map((call) => call.toolCallId),
    [second, first],
  );
  assert.equal(group.calls.length, 2);
});

test("pending approval appears inline, then resolves into its tool", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  const approvalId = f.approvalId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(Durable.ApprovalRequested, { reason: "Run command?" }, { turnId: f.turnId, toolCallId, approvalId });
  const pending = projectConversation(f.conversationId, [f.slice()]);
  assert.equal(items(pending, "approval-request").length, 1);
  assert.equal(pending.pendingApproval?.approvalId, approvalId);
  assert.equal(items(pending, "tool-activity")[0].calls[0].status, "awaiting-approval");

  await f.add(
    Durable.ApprovalResolved,
    { decision: ApprovalDecisions.Allow },
    { turnId: f.turnId, toolCallId, approvalId },
  );
  await f.add(Durable.ToolResultCompleted, { output: { stdout: "ok", exitCode: 0 } }, { turnId: f.turnId, toolCallId });
  const resolved = projectConversation(f.conversationId, [f.slice()]);
  assert.equal(items(resolved, "approval-request").length, 0);
  assert.equal(items(resolved, "tool-activity")[0].calls[0].approval.status, "allowed");
});

test("an approval left pending by cancellation is not actionable", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  const approvalId = f.approvalId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "sleep 10" }, providerOrder: 0, requiresApproval: true },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(Durable.ApprovalRequested, { reason: "Run?" }, { turnId: f.turnId, toolCallId, approvalId });
  await f.add(Durable.ToolResultAborted, { error: failure, synthetic: true }, { turnId: f.turnId, toolCallId });
  await f.add(Durable.TurnAborted, { reason: "user stopped" }, { turnId: f.turnId });
  const view = projectConversation(f.conversationId, [f.slice()]);
  assert.equal(items(view, "approval-request").length, 0);
  assert.equal(items(view, "tool-activity")[0].calls[0].approval.status, "cancelled");
  assert.equal(view.pendingApproval, undefined);
});

test("late live deltas cannot resurrect a terminal turn", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepFailed, { error: failure }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(Durable.TurnFailed, { error: failure }, { turnId: f.turnId });
  const delta = f.event(Live.ContentDelta, { text: "late" }, { turnId: f.turnId, stepId: f.stepId });
  const view = projectConversation(f.conversationId, [f.slice({ live: [delta] })]);
  assert.equal(view.activeTurn, undefined);
  assert.equal(items(view, "assistant-message").length, 0);
  assert.ok(view.diagnostics.some((issue) => issue.code === "live-text-unbacked"));
});

test("a sequence gap holds later records out of the view", async (t) => {
  const f = await sessionFixture(t);
  await f.startTurn("not yet visible");
  const held = f.slice({ records: f.records.slice(0, 2), lastSequence: 2 });
  const gapped = ingestRecord(held, f.records[3]);
  assert.equal(gapped.hasGap, true);
  assert.equal(gapped.lastSequence, 2);
  assert.deepEqual(items(projectConversation(f.conversationId, [gapped]), "user-message"), []);
  assert.ok(gapped.diagnostics.some((issue) => issue.code === "sequence-gap"));
});

test("redelivery of an existing record is idempotent", async (t) => {
  const f = await sessionFixture(t);
  const original = f.slice();
  const once = ingestRecord(original, f.records[1]);
  const twice = ingestRecord(once, f.records[1]);
  assert.deepEqual(twice, original);
});

test("session ordinals make item order and keys stable regardless of input array order", async (t) => {
  const conversation = await sessionFixture(t, { ordinal: 0 });
  const later = await sessionFixture(t, { conversationId: conversation.conversationId, ordinal: 1 });
  await conversation.startTurn("Earlier");
  await later.startTurn("Later");
  const left = projectConversation(conversation.conversationId, [later.slice(), conversation.slice()]);
  const right = projectConversation(conversation.conversationId, [conversation.slice(), later.slice()]);
  assert.deepEqual(
    left.items.map((item) => item.key),
    right.items.map((item) => item.key),
  );
  assert.deepEqual(
    items(left, "user-message").map((item) => item.text),
    ["Earlier", "Later"],
  );
  assert.equal(items(left, "session-boundary").length, 1);
});

test("a durable user message supersedes the optimistic one", async (t) => {
  const f = await sessionFixture(t);
  const optimistic = { turnId: f.turnId, text: "Draft" };
  const before = projectConversation(f.conversationId, [f.slice({ optimistic })]);
  assert.deepEqual(
    items(before, "user-message").map((item) => item.source),
    ["optimistic"],
  );
  await f.startTurn("Accepted");
  const after = projectConversation(f.conversationId, [f.slice({ optimistic })]);
  assert.deepEqual(
    items(after, "user-message").map((item) => [item.text, item.source]),
    [["Accepted", "durable"]],
  );
});

test("a completed tool retains its cancellation-requested metadata", async (t) => {
  const f = await sessionFixture(t);
  const toolCallId = f.toolCallId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "echo ok" }, providerOrder: 0, requiresApproval: false },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  await f.add(
    Durable.ToolResultCompleted,
    { output: { stdout: "ok", exitCode: 0 }, cancellation: { requested: true, reason: "stopped" } },
    { turnId: f.turnId, toolCallId },
  );
  const call = items(projectConversation(f.conversationId, [f.slice()]), "tool-activity")[0].calls[0];
  assert.equal(call.status, "completed");
  assert.deepEqual(call.cancellation, { requested: true, reason: "stopped" });
});

test("synthetic aborted results are distinguished from real tool failures", async (t) => {
  const f = await sessionFixture(t);
  const syntheticId = f.toolCallId();
  const realId = f.toolCallId();
  await f.startTurn();
  await f.startStep();
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: {}, providerOrder: 0, requiresApproval: false },
    { turnId: f.turnId, stepId: f.stepId, toolCallId: syntheticId },
  );
  await f.add(
    Durable.ToolResultAborted,
    { error: failure, synthetic: true },
    { turnId: f.turnId, toolCallId: syntheticId },
  );
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: {}, providerOrder: 1, requiresApproval: false },
    { turnId: f.turnId, stepId: f.stepId, toolCallId: realId },
  );
  await f.add(Durable.ToolResultFailed, { error: failure }, { turnId: f.turnId, toolCallId: realId });
  const calls = items(projectConversation(f.conversationId, [f.slice()]), "tool-activity")[0].calls;
  assert.deepEqual(
    calls.map((call) => [call.status, call.synthetic]),
    [
      ["aborted", true],
      ["failed", false],
    ],
  );
});

test("turn phase follows provider, streaming, approval, and tool states", async (t) => {
  const f = await sessionFixture(t);
  const phase = (slice = f.slice()) => projectConversation(f.conversationId, [slice]).activeTurn?.phase;
  assert.equal(phase(), undefined);
  await f.startTurn();
  assert.equal(phase(), "waiting-for-model");
  await f.startStep();
  assert.equal(phase(), "waiting-for-model");
  const delta = f.event(Live.ContentDelta, { text: "Working" }, { turnId: f.turnId, stepId: f.stepId });
  assert.equal(phase(f.slice({ live: [delta] })), "generating");
  await f.add(Durable.ProviderStepCompleted, { stopReason: "tool-use" }, { turnId: f.turnId, stepId: f.stepId });
  const toolCallId = f.toolCallId();
  await f.add(
    Durable.ToolRequested,
    { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true },
    { turnId: f.turnId, stepId: f.stepId, toolCallId },
  );
  const approvalId = f.approvalId();
  await f.add(Durable.ApprovalRequested, { reason: "Run?" }, { turnId: f.turnId, toolCallId, approvalId });
  assert.equal(phase(), "awaiting-approval");
  await f.add(
    Durable.ApprovalResolved,
    { decision: ApprovalDecisions.Allow },
    { turnId: f.turnId, toolCallId, approvalId },
  );
  assert.equal(phase(), "executing-tools");
});
