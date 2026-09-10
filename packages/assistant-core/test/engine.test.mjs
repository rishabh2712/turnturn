import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalDecisions,
  CommandTypes,
  DurableRecordTypes,
  formatCommandId,
  formatConversationId,
  formatSessionId,
  formatTurnId,
  LiveEventTypes,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { ProviderHistoryItemTypes, reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { createAssistantEngine } from "../dist/engine.js";
import {
  completed,
  FixedClock,
  failed,
  MemoryDurableSink,
  MemoryLiveSink,
  MemoryToolExecutor,
  ScriptedProvider,
  SequentialIds,
  StaticPolicy,
  testError,
} from "../dist/testing.js";

const uuid = (n) => `018f1f4e-8d5f-7abc-8123-823456789${String(n).padStart(3, "0")}`;
const ids = {
  conversationId: formatConversationId(uuid(1)),
  sessionId: formatSessionId(uuid(2)),
  turnId: formatTurnId(uuid(3)),
};

function command(type, payload, scope = {}, n = 1, idempotencyKey) {
  return {
    schemaVersion: 1,
    commandId: formatCommandId(uuid(100 + n)),
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    payload,
    ...scope,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

async function seededEngine({ provider, policy = new StaticPolicy(), tools } = {}) {
  const durable = new MemoryDurableSink();
  const live = new MemoryLiveSink();
  const engine = createAssistantEngine({
    provider: provider ?? new ScriptedProvider([[{ type: "completed", reason: "complete" }]]),
    policy,
    tools: tools ?? new MemoryToolExecutor(() => completed("ok")),
    durable,
    live,
    ids: new SequentialIds(),
    clock: new FixedClock(),
  });

  await engine.submit(command(CommandTypes.ConversationCreate, { title: "Demo" }, {}, 1));
  await engine.submit(command(CommandTypes.SessionCreate, { provider: "scripted" }, {}, 2));
  return { engine, durable, live };
}

test("turn happy path persists the exact durable record type sequence", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "completed", reason: "complete" },
    ],
  ]);
  const { engine, durable } = await seededEngine({ provider });

  const outcome = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "say hello" }, { turnId: ids.turnId }, 3),
  );

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(
    durable.records().map((record) => record.type),
    [
      DurableRecordTypes.ConversationCreated,
      DurableRecordTypes.SessionCreated,
      DurableRecordTypes.TurnStarted,
      DurableRecordTypes.UserInputAccepted,
      DurableRecordTypes.ProviderStepStarted,
      DurableRecordTypes.AssistantMessageCompleted,
      DurableRecordTypes.ProviderStepCompleted,
      DurableRecordTypes.TurnCompleted,
    ],
  );
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("same-step tool calls execute strictly in provider order", async () => {
  const executed = [];
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native-b", name: "probe", input: { value: "b" } } },
      { type: "tool-call-complete", call: { callId: "native-a", name: "probe", input: { value: "a" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [{ type: "completed", reason: "complete" }],
  ]);
  const tools = new MemoryToolExecutor((request) => {
    executed.push(request.input.value);
    return completed({ echoed: request.input.value });
  });
  const { engine, durable } = await seededEngine({ provider, tools });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "run both" }, { turnId: ids.turnId }, 4));

  assert.deepEqual(executed, ["b", "a"]);
  const requests = durable.records().filter((record) => record.type === DurableRecordTypes.ToolRequested);
  assert.deepEqual(
    requests.map((record) => record.payload.providerOrder),
    [0, 1],
  );
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("mixed sibling tool success and denial both reach the next provider step", async () => {
  const histories = [];
  const provider = {
    name: "history-probe",
    async *run(request) {
      histories.push(request.history);
      if (histories.length === 1) {
        yield { type: "tool-call-complete", call: { callId: "native-ok", name: "ok", input: { value: "ok" } } };
        yield { type: "tool-call-complete", call: { callId: "native-deny", name: "deny", input: { value: "deny" } } };
        yield { type: "completed", reason: "tool-use" };
        return;
      }
      yield { type: "completed", reason: "complete" };
    },
  };
  const policy = {
    async decide(request) {
      if (request.name === "deny") return { kind: "deny", error: testError("DENIED", "denied") };
      return { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor((request) => completed({ echoed: request.name }));
  const { engine, durable } = await seededEngine({ provider, policy, tools });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "run siblings" }, { turnId: ids.turnId }, 26));

  assert.equal(histories.length, 2);
  const secondStepToolItems = histories[1].items.filter((item) =>
    [ProviderHistoryItemTypes.ToolRequest, ProviderHistoryItemTypes.ToolResult].includes(item.type),
  );
  assert.deepEqual(
    secondStepToolItems.map((item) =>
      item.type === ProviderHistoryItemTypes.ToolRequest ? ["request", item.name] : ["result", item.status],
    ),
    [
      ["request", "ok"],
      ["result", "completed"],
      ["request", "deny"],
      ["result", "denied"],
    ],
  );
  assert.equal(tools.requests.length, 1);
  assert.equal(tools.requests[0].name, "ok");
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("policy deny and abort produce synthetic terminal tool records", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native", name: "write", input: { path: "a" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [{ type: "completed", reason: "complete" }],
  ]);
  const denied = await seededEngine({
    provider,
    policy: new StaticPolicy({ kind: "deny", error: testError("DENIED") }),
  });

  await denied.engine.submit(command(CommandTypes.TurnSubmit, { input: "try" }, { turnId: ids.turnId }, 5));
  const deniedRecord = denied.durable.records().find((record) => record.type === DurableRecordTypes.ToolResultDenied);
  assert.equal(deniedRecord.payload.synthetic, true);
  assert.deepEqual(reduceEngineState(denied.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(denied.durable.records());

  const aborted = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "write", input: { path: "a" } } },
        { type: "completed", reason: "tool-use" },
      ],
    ]),
    policy: new StaticPolicy({ kind: "abort", error: testError("ABORT") }),
  });
  await aborted.engine.submit(command(CommandTypes.TurnSubmit, { input: "try" }, { turnId: ids.turnId }, 6));
  const abortedRecord = aborted.durable
    .records()
    .find((record) => record.type === DurableRecordTypes.ToolResultAborted);
  assert.equal(abortedRecord.payload.synthetic, true);
  assert.equal(aborted.durable.records().at(-1).type, DurableRecordTypes.TurnAborted);
  assert.deepEqual(reduceEngineState(aborted.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(aborted.durable.records());
});

test("policy allow-modified records modified input and ask resolves through approval command", async () => {
  const modified = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "read", input: { path: "before" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
    policy: new StaticPolicy({ kind: "allow-modified", input: { path: "after" } }),
  });
  await modified.engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 8));
  const modifiedRequest = modified.durable.records().find((record) => record.type === DurableRecordTypes.ToolRequested);
  assert.deepEqual(modifiedRequest.payload.input, { path: "after" });
  assert.deepEqual(reduceEngineState(modified.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(modified.durable.records());

  const asked = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
    policy: new StaticPolicy({ kind: "ask", reason: "run command" }),
  });
  const running = asked.engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 9));
  const approval = await waitForRecord(asked.durable, DurableRecordTypes.ApprovalRequested);
  const approvalOutcome = await asked.engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      { decision: ApprovalDecisions.Allow },
      { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
      10,
    ),
  );
  assert.equal(approvalOutcome.kind, "accepted");
  await running;
  assert.ok(asked.durable.records().some((record) => record.type === DurableRecordTypes.ApprovalResolved));
  assert.deepEqual(reduceEngineState(asked.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(asked.durable.records());
});

test("duplicate approval resolution is rejected without a second durable resolution", async () => {
  const asked = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
    policy: new StaticPolicy({ kind: "ask", reason: "run command" }),
  });
  const running = asked.engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 15));
  const approval = await waitForRecord(asked.durable, DurableRecordTypes.ApprovalRequested);

  const first = await asked.engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      { decision: ApprovalDecisions.Allow },
      { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
      16,
    ),
  );
  const duplicate = await asked.engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      { decision: ApprovalDecisions.Deny },
      { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
      17,
    ),
  );
  await running;

  assert.equal(first.kind, "accepted");
  assert.deepEqual(duplicate, {
    kind: "rejected",
    code: "APPROVAL_NOT_PENDING",
    message: "Approval is not pending",
  });
  assert.equal(
    asked.durable.records().filter((record) => record.type === DurableRecordTypes.ApprovalResolved).length,
    1,
  );
  assert.deepEqual(reduceEngineState(asked.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(asked.durable.records());
});

test("approval resolved after cancellation is rejected and does not resurrect the turn", async () => {
  const asked = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } },
        { type: "completed", reason: "tool-use" },
      ],
    ]),
    policy: new StaticPolicy({ kind: "ask", reason: "run command" }),
  });
  const running = asked.engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 18));
  const approval = await waitForRecord(asked.durable, DurableRecordTypes.ApprovalRequested);
  const cancel = await asked.engine.submit(
    command(CommandTypes.TurnCancel, { reason: "stop" }, { turnId: ids.turnId }, 19),
  );
  await running;

  const lateApproval = await asked.engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      { decision: ApprovalDecisions.Allow },
      { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
      20,
    ),
  );

  assert.equal(cancel.kind, "accepted");
  assert.deepEqual(lateApproval, {
    kind: "rejected",
    code: "APPROVAL_NOT_PENDING",
    message: "Approval is not pending",
  });
  assert.equal(asked.durable.records().at(-1).type, DurableRecordTypes.TurnAborted);
  assert.equal(
    asked.durable.records().filter((record) => record.type === DurableRecordTypes.ApprovalResolved).length,
    0,
  );
  assert.deepEqual(reduceEngineState(asked.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(asked.durable.records());
});

test("cancel during provider streaming waits for durable turn.aborted and ignores late provider completion", async () => {
  let emittedToolCall;
  const emittedToolCallPromise = new Promise((resolve) => {
    emittedToolCall = resolve;
  });
  const provider = {
    name: "abort-race",
    async *run(request) {
      yield { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } };
      emittedToolCall();
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      yield { type: "completed", reason: "complete" };
    },
  };
  const { engine, durable } = await seededEngine({ provider });
  const running = engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 21));

  await emittedToolCallPromise;
  const cancel = await engine.submit(
    command(CommandTypes.TurnCancel, { reason: "stop streaming" }, { turnId: ids.turnId }, 22),
  );
  await running;

  assert.equal(cancel.kind, "accepted");
  assert.ok(cancel.records.some((record) => record.type === DurableRecordTypes.TurnAborted));
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnAborted);
  assert.equal(
    durable.records().some((record) => record.type === DurableRecordTypes.TurnCompleted),
    false,
  );
  assertEveryRequestedToolTerminated(durable.records());
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("cancel during tool execution records the finished outcome with cancellation metadata", async () => {
  let toolStarted;
  const toolStartedPromise = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native", name: "slow", input: { value: "work" } } },
      { type: "completed", reason: "tool-use" },
    ],
  ]);
  const tools = new MemoryToolExecutor(async (request) => {
    toolStarted();
    await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
    return completed({ finishedAfterAbort: true });
  });
  const { engine, durable } = await seededEngine({ provider, tools });
  const running = engine.submit(command(CommandTypes.TurnSubmit, { input: "run slow" }, { turnId: ids.turnId }, 27));

  await toolStartedPromise;
  const cancel = await engine.submit(
    command(CommandTypes.TurnCancel, { reason: "stop tool" }, { turnId: ids.turnId }, 28),
  );
  await running;

  const completedTool = durable.records().find((record) => record.type === DurableRecordTypes.ToolResultCompleted);
  assert.deepEqual(completedTool.payload, {
    output: { finishedAfterAbort: true },
    cancellation: { requested: true, reason: "stop tool" },
  });
  assert.equal(
    durable.records().some((record) => record.type === DurableRecordTypes.ToolResultAborted),
    false,
  );
  assert.equal(cancel.kind, "accepted");
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnAborted);
  assertEveryRequestedToolTerminated(durable.records());
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("cancel before turn starts and after completion is rejected without another terminal record", async () => {
  const { engine, durable } = await seededEngine();
  const beforeStart = await engine.submit(
    command(CommandTypes.TurnCancel, { reason: "too early" }, { turnId: ids.turnId }, 29),
  );

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "finish" }, { turnId: ids.turnId }, 30));
  const terminalCountAfterCompletion = terminalTurnRecords(durable.records()).length;
  const afterComplete = await engine.submit(
    command(CommandTypes.TurnCancel, { reason: "too late" }, { turnId: ids.turnId }, 31),
  );

  assert.deepEqual(beforeStart, {
    kind: "rejected",
    code: "TURN_NOT_RUNNING",
    message: "Turn is not running",
  });
  assert.deepEqual(afterComplete, {
    kind: "rejected",
    code: "TURN_NOT_RUNNING",
    message: "Turn is not running",
  });
  assert.equal(terminalTurnRecords(durable.records()).length, terminalCountAfterCompletion);
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnCompleted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("recoverable tool failure continues to the next provider step", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native", name: "read", input: { path: "missing" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [
      { type: "text-delta", text: "handled" },
      { type: "completed", reason: "complete" },
    ],
  ]);
  const tools = new MemoryToolExecutor(() => failed("NOT_FOUND", "missing"));
  const { engine, durable } = await seededEngine({ provider, tools });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 11));

  assert.ok(durable.records().some((record) => record.type === DurableRecordTypes.ToolResultFailed));
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnCompleted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("throwing live sink does not fail the turn", async () => {
  const durable = new MemoryDurableSink();
  const live = new MemoryLiveSink();
  live.throwOnPublish = true;
  const engine = createAssistantEngine({
    provider: new ScriptedProvider([
      [
        { type: "text-delta", text: "ok" },
        { type: "completed", reason: "complete" },
      ],
    ]),
    policy: new StaticPolicy(),
    tools: new MemoryToolExecutor(() => completed("ok")),
    durable,
    live,
    ids: new SequentialIds(),
    clock: new FixedClock(),
  });

  await engine.submit(command(CommandTypes.ConversationCreate, { title: "Demo" }, {}, 12));
  await engine.submit(command(CommandTypes.SessionCreate, { provider: "scripted" }, {}, 13));
  const outcome = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "say ok" }, { turnId: ids.turnId }, 14),
  );

  assert.equal(outcome.kind, "accepted");
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnCompleted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("terminal live events are published only after their durable record exists", async () => {
  const durable = new MemoryDurableSink();
  const live = new OrderingLiveSink(durable);
  const engine = createAssistantEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "probe", input: { value: "ok" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
    policy: new StaticPolicy(),
    tools: new MemoryToolExecutor(() => completed({ value: "ok" })),
    durable,
    live,
    ids: new SequentialIds(),
    clock: new FixedClock(),
  });

  await engine.submit(command(CommandTypes.ConversationCreate, { title: "Demo" }, {}, 23));
  await engine.submit(command(CommandTypes.SessionCreate, { provider: "scripted" }, {}, 24));
  await engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 25));

  const terminalObservations = live.observations.filter((observation) =>
    [LiveEventTypes.ToolCompleted, LiveEventTypes.TurnCompleted].includes(observation.eventType),
  );
  assert.deepEqual(
    terminalObservations.map((observation) => [observation.eventType, observation.durableAlreadyPresent]),
    [
      [LiveEventTypes.ToolCompleted, true],
      [LiveEventTypes.TurnCompleted, true],
    ],
  );
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("idempotency returns duplicate with original records", async () => {
  const { engine } = await seededEngine();
  const submit = command(CommandTypes.TurnSubmit, { input: "once" }, { turnId: ids.turnId }, 7, "turn-submit-once");

  const first = await engine.submit(submit);
  const second = await engine.submit({ ...submit, commandId: formatCommandId(uuid(999)) });

  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "duplicate");
  assert.deepEqual(second.records, first.records);
});

function assertEveryRequestedToolTerminated(records) {
  const terminalTypes = new Set([
    DurableRecordTypes.ToolResultCompleted,
    DurableRecordTypes.ToolResultFailed,
    DurableRecordTypes.ToolResultDenied,
    DurableRecordTypes.ToolResultAborted,
  ]);
  const requested = records.filter((record) => record.type === DurableRecordTypes.ToolRequested);

  for (const request of requested) {
    const terminals = records.filter(
      (record) => terminalTypes.has(record.type) && record.toolCallId === request.toolCallId,
    );
    assert.equal(terminals.length, 1, `expected exactly one terminal result for ${request.toolCallId}`);
  }
}

function terminalTurnRecords(records) {
  return records.filter((record) =>
    [DurableRecordTypes.TurnCompleted, DurableRecordTypes.TurnFailed, DurableRecordTypes.TurnAborted].includes(
      record.type,
    ),
  );
}

async function waitForRecord(durable, type) {
  for (let index = 0; index < 50; index += 1) {
    const record = durable.records().find((candidate) => candidate.type === type);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

class OrderingLiveSink extends MemoryLiveSink {
  observations = [];

  constructor(durable) {
    super();
    this.durable = durable;
  }

  publish(event) {
    const durableType = durableTypeForLiveTerminal(event.type);
    if (durableType) {
      this.observations.push({
        eventType: event.type,
        durableAlreadyPresent: this.durable.records().some((record) => terminalMatchesLive(record, durableType, event)),
      });
    }
    super.publish(event);
  }
}

function durableTypeForLiveTerminal(eventType) {
  switch (eventType) {
    case LiveEventTypes.ToolCompleted:
      return DurableRecordTypes.ToolResultCompleted;
    case LiveEventTypes.ToolFailed:
      return DurableRecordTypes.ToolResultFailed;
    case LiveEventTypes.TurnCompleted:
      return DurableRecordTypes.TurnCompleted;
    case LiveEventTypes.TurnFailed:
      return DurableRecordTypes.TurnFailed;
    case LiveEventTypes.TurnAborted:
      return DurableRecordTypes.TurnAborted;
    default:
      return undefined;
  }
}

function terminalMatchesLive(record, durableType, event) {
  return (
    record.type === durableType &&
    record.conversationId === event.conversationId &&
    record.sessionId === event.sessionId &&
    record.turnId === event.turnId &&
    (event.toolCallId === undefined || record.toolCallId === event.toolCallId)
  );
}
