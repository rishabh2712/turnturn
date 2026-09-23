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
import { projectModelContext } from "../dist/context/index.js";
import { createAssistantEngine } from "../dist/engine.js";
import { noopObservation } from "../dist/observability/index.js";
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

async function seededEngine({ provider, policy = new StaticPolicy(), tools, scope = {}, observation } = {}) {
  const durable = new MemoryDurableSink();
  const live = new MemoryLiveSink();
  const engine = createAssistantEngine({
    provider: provider ?? new ScriptedProvider([[{ type: "completed", reason: "complete" }]]),
    policy,
    tools:
      tools ??
      new MemoryToolExecutor(
        () => completed("ok"),
        [
          { name: "read", description: "Read a file", parameters: {}, mutating: false },
          { name: "glob", description: "Glob files", parameters: {}, mutating: false },
          { name: "grep", description: "Search files", parameters: {}, mutating: false },
          { name: "shell", description: "Run a shell command", parameters: {}, mutating: true },
          { name: "write", description: "Write a file", parameters: {}, mutating: true },
          { name: "edit", description: "Edit a file", parameters: {}, mutating: true },
        ],
      ),
    durable,
    live,
    ids: new SequentialIds(),
    clock: new FixedClock(),
    ...(observation === undefined ? {} : { observation }),
  });

  await engine.submit(command(CommandTypes.ConversationCreate, { title: "Demo" }, scope, 1));
  await engine.submit(command(CommandTypes.SessionCreate, { provider: "scripted" }, scope, 2));
  return { engine, durable, live };
}

test("disabled observation leaves durable records and live events byte-for-byte unchanged", async () => {
  const unobserved = await seededEngine();
  const disabled = await seededEngine({ observation: noopObservation });
  const submit = command(CommandTypes.TurnSubmit, { input: "same input" }, { turnId: ids.turnId }, 70);

  const unobservedOutcome = await unobserved.engine.submit(submit);
  const disabledOutcome = await disabled.engine.submit(submit);

  assert.equal(JSON.stringify(disabledOutcome), JSON.stringify(unobservedOutcome));
  assert.equal(JSON.stringify(disabled.durable.records()), JSON.stringify(unobserved.durable.records()));
  assert.equal(JSON.stringify(disabled.live.events), JSON.stringify(unobserved.live.events));
  assert.equal(JSON.stringify(disabled.engine.state()), JSON.stringify(unobserved.engine.state()));
  assert.deepEqual(reduceEngineState(disabled.durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(disabled.durable.records()).issues, []);
});

test("throwing observation cannot prevent a durable terminal turn record", async () => {
  const observation = {
    startTurn() {
      return {
        startStep() {
          throw new Error("observer failed");
        },
        observeTool() {
          throw new Error("observer failed");
        },
        observeApproval() {
          throw new Error("observer failed");
        },
        complete() {
          throw new Error("observer failed");
        },
        fail() {
          throw new Error("observer failed");
        },
        cancel() {
          throw new Error("observer failed");
        },
      };
    },
    degraded() {
      throw new Error("observer degradation reporter failed");
    },
  };
  const { engine, durable } = await seededEngine({
    observation,
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "observed-tool", name: "probe", input: { value: 1 } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const outcome = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "finish despite tracing" }, { turnId: ids.turnId }, 71),
  );

  assert.equal(outcome.kind, "accepted");
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnCompleted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("provider steps expose model context and preserve sibling provider attempts", async () => {
  const observed = { contexts: [], attempts: [], stepTerminals: [] };
  const observation = recordingObservation(observed);
  const provider = {
    name: "attempt-probe",
    async *run(_request, step) {
      const first = step.startProviderAttempt({ provider: "attempt-probe", model: "model" });
      first.fail({ kind: "transport", message: "first failed", retryable: true });
      const second = step.startProviderAttempt({ provider: "attempt-probe", model: "model" });
      second.complete({ reason: "complete", durationMs: 5 });
      yield { type: "completed", reason: "complete" };
    },
  };
  const tools = new MemoryToolExecutor(
    () => completed("unused"),
    [{ name: "read", description: "Read a file", mutating: false, parameters: { type: "object" } }],
  );
  const { engine, durable } = await seededEngine({ provider, tools, observation });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "inspect" }, { turnId: ids.turnId }, 72));

  assert.equal(observed.contexts.length, 1);
  assert.deepEqual(
    observed.contexts[0].catalog.contributions.map((contribution) => contribution.kind),
    ["conversation-history", "tool-interactions", "tool-definitions"],
  );
  assert.deepEqual(
    observed.contexts[0].selections.map((selection) => selection.disposition),
    ["included", "included", "included", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable"],
  );
  assert.deepEqual(
    observed.attempts.map((attempt) => attempt.terminal),
    ["failed", "completed"],
  );
  assert.deepEqual(observed.stepTerminals, ["completed"]);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

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

function recordingObservation(observed) {
  return {
    startTurn() {
      return {
        startStep() {
          return {
            modelContext(context) {
              observed.contexts.push(context);
            },
            startProviderAttempt() {
              const attempt = { terminal: undefined };
              observed.attempts.push(attempt);
              return {
                wireRequest() {},
                responseMetadata() {},
                rawResponseFrame() {},
                providerEvent() {},
                complete() {
                  attempt.terminal = "completed";
                },
                fail() {
                  attempt.terminal = "failed";
                },
                cancel() {
                  attempt.terminal = "cancelled";
                },
                issue() {},
              };
            },
            complete() {
              observed.stepTerminals.push("completed");
            },
            fail() {
              observed.stepTerminals.push("failed");
            },
            cancel() {
              observed.stepTerminals.push("cancelled");
            },
          };
        },
        observeTool(event) {
          observed.tools?.push(event);
        },
        observeApproval(event) {
          observed.approvals?.push(event);
        },
        complete() {},
        fail() {},
        cancel() {},
      };
    },
    degraded() {},
  };
}

test("tool runtime observations preserve validation, policy, execution, output, result, and provider identity", async () => {
  const observed = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "provider-call-1", name: "probe", input: { value: "before" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [{ type: "completed", reason: "complete" }],
  ]);
  const tools = new MemoryToolExecutor((request) => {
    request.callbacks.stdout("working");
    request.callbacks.progress("halfway");
    return completed({ value: request.input.value });
  });
  const { engine, durable } = await seededEngine({
    provider,
    tools,
    policy: new StaticPolicy({ kind: "allow-modified", input: { value: "after" } }),
    observation: recordingObservation(observed),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "run" }, { turnId: ids.turnId }, 73));

  assert.deepEqual(
    observed.tools.map((event) => event.type),
    [
      "validation-input",
      "validation-result",
      "policy-decision",
      "validation-input",
      "validation-result",
      "execution-started",
      "execution-output",
      "execution-output",
      "execution-finished",
      "result-recorded",
    ],
  );
  assert.deepEqual(
    observed.tools.filter((event) => event.type === "validation-input").map((event) => event.phase),
    ["provider", "policy-modified"],
  );
  assert.ok(observed.tools.every((event) => event.scope.providerToolCallId === "provider-call-1"));
  assert.equal(new Set(observed.tools.map((event) => event.scope.toolCallId)).size, 1);
  assert.deepEqual(observed.tools.at(-1).result, { status: "completed", output: { value: "after" } });
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("context projection keeps ordered history identity and counts tool interactions separately", async () => {
  const observed = { contexts: [], attempts: [], stepTerminals: [] };
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "provider-call-2", name: "probe", input: { value: 1 } } },
      { type: "completed", reason: "tool-use" },
    ],
    [{ type: "completed", reason: "complete" }],
  ]);
  const { engine } = await seededEngine({ provider, observation: recordingObservation(observed) });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "inspect context" }, { turnId: ids.turnId }, 74));

  const second = projectModelContext(observed.contexts[1]);
  assert.deepEqual(
    second.messages.map((message) => [message.role, message.historyType]),
    [
      ["user", "user.input"],
      ["assistant", "tool.request"],
      ["tool", "tool.result"],
    ],
  );
  assert.ok(second.messages.every((message) => message.recordId && message.sequence > 0));
  const history = second.contributions.find((contribution) => contribution.kind === "conversation-history");
  const interactions = second.contributions.find((contribution) => contribution.kind === "tool-interactions");
  assert.equal(history.itemCount, 1);
  assert.equal(interactions.itemCount, 2);
  assert.ok(history.estimatedTokens > 0);
  assert.ok(interactions.estimatedTokens > 0);
  assert.equal(second.selections.find((selection) => selection.kind === "memory").disposition, "unavailable");
});

test("assistant text and live deltas keep their provider step identity", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "reasoning-delta", text: "plan" },
      { type: "text-delta", text: "reading" },
      { type: "tool-call-complete", call: { callId: "native-read", name: "read", input: { path: "a.txt" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [
      { type: "reasoning-delta", text: "summarize" },
      { type: "text-delta", text: "done" },
      { type: "completed", reason: "complete" },
    ],
  ]);
  const { engine, durable, live } = await seededEngine({ provider });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 50));

  const steps = durable.records().filter((record) => record.type === DurableRecordTypes.ProviderStepStarted);
  const messages = durable.records().filter((record) => record.type === DurableRecordTypes.AssistantMessageCompleted);
  const deltas = live.events.filter((event) =>
    [LiveEventTypes.ContentDelta, LiveEventTypes.ReasoningDelta].includes(event.type),
  );
  assert.equal(steps.length, 2);
  assert.deepEqual(
    messages.map((record) => record.stepId),
    steps.map((record) => record.stepId),
  );
  assert.deepEqual(
    deltas.map((event) => event.stepId),
    [steps[0].stepId, steps[0].stepId, steps[1].stepId, steps[1].stepId],
  );
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
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

test("provider history is scoped to the current session", async () => {
  const first = {
    conversationId: formatConversationId(uuid(31)),
    sessionId: formatSessionId(uuid(32)),
    turnId: formatTurnId(uuid(33)),
  };
  const second = {
    conversationId: formatConversationId(uuid(41)),
    sessionId: formatSessionId(uuid(42)),
    turnId: formatTurnId(uuid(43)),
  };
  const histories = [];
  const provider = {
    name: "history-scope-probe",
    async *run(request) {
      histories.push(request.history);
      yield { type: "completed", reason: "complete" };
    },
  };
  const firstSession = await seededEngine({ provider, scope: first });
  await firstSession.engine.submit(command(CommandTypes.TurnSubmit, { input: "first-session-only" }, first, 33));
  const secondSession = await seededEngine({ provider, scope: second });
  await secondSession.engine.submit(command(CommandTypes.TurnSubmit, { input: "second-session-only" }, second, 43));

  assert.equal(histories.length, 2);
  assert.deepEqual(
    histories[1].items.filter((item) => item.type === ProviderHistoryItemTypes.UserInput).map((item) => item.content),
    ["second-session-only"],
  );
  const secondInputRecord = secondSession.durable
    .records()
    .find(
      (record) => record.type === DurableRecordTypes.UserInputAccepted && record.payload.text === "second-session-only",
    );
  assert.equal(
    histories[1].items.find((item) => item.type === ProviderHistoryItemTypes.UserInput).sequence,
    secondInputRecord.sequence,
  );
  assert.deepEqual(histories[1].issues, []);
  assert.deepEqual(reduceEngineState(firstSession.durable.records()).issues, []);
  assert.deepEqual(reduceEngineState(secondSession.durable.records()).issues, []);
});

test("policy deny and abort produce synthetic terminal tool records", async () => {
  const deniedObserved = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
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
    observation: recordingObservation(deniedObserved),
  });

  await denied.engine.submit(command(CommandTypes.TurnSubmit, { input: "try" }, { turnId: ids.turnId }, 5));
  const deniedRecord = denied.durable.records().find((record) => record.type === DurableRecordTypes.ToolResultDenied);
  assert.equal(deniedRecord.payload.synthetic, true);
  assert.equal(deniedObserved.tools.at(-1).result.status, "denied");
  assert.deepEqual(reduceEngineState(denied.durable.records()).issues, []);
  assertEveryRequestedToolTerminated(denied.durable.records());

  const abortedObserved = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
  const aborted = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "write", input: { path: "a" } } },
        { type: "completed", reason: "tool-use" },
      ],
    ]),
    policy: new StaticPolicy({ kind: "abort", error: testError("ABORT") }),
    observation: recordingObservation(abortedObserved),
  });
  await aborted.engine.submit(command(CommandTypes.TurnSubmit, { input: "try" }, { turnId: ids.turnId }, 6));
  const abortedRecord = aborted.durable
    .records()
    .find((record) => record.type === DurableRecordTypes.ToolResultAborted);
  assert.equal(abortedRecord.payload.synthetic, true);
  assert.equal(abortedObserved.tools.at(-1).result.status, "aborted");
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

  const approvalObserved = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
  const asked = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
    policy: new StaticPolicy({ kind: "ask", reason: "run command" }),
    observation: recordingObservation(approvalObserved),
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
  assert.deepEqual(
    approvalObserved.approvals.map((event) => event.type),
    ["requested", "resolved"],
  );
  assert.equal(approvalObserved.approvals[0].scope.approvalId, approvalObserved.approvals[1].scope.approvalId);
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
  const approvalObserved = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
  const asked = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "native", name: "shell", input: { command: "pwd" } } },
        { type: "completed", reason: "tool-use" },
      ],
    ]),
    policy: new StaticPolicy({ kind: "ask", reason: "run command" }),
    observation: recordingObservation(approvalObserved),
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
  assert.deepEqual(
    approvalObserved.approvals.map((event) => event.type),
    ["requested", "cancelled"],
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
  const observed = { contexts: [], attempts: [], stepTerminals: [], tools: [], approvals: [] };
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
  const { engine, durable } = await seededEngine({ provider, tools, observation: recordingObservation(observed) });
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
  assert.deepEqual(observed.tools.at(-1).cancellation, { requested: true, reason: "stop tool" });
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

test("malformed provider tool input fails the call and continues to the next provider step", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native", name: "read", input: { offset: 1 } } },
      { type: "completed", reason: "tool-use" },
    ],
    [
      { type: "text-delta", text: "retryable" },
      { type: "completed", reason: "complete" },
    ],
  ]);
  let executed = false;
  const tools = new MemoryToolExecutor(() => {
    executed = true;
    return completed("should not run");
  });
  tools.validate = () => ({
    ok: false,
    error: { code: "TOOL_SCHEMA_INVALID", message: "path is required", retryable: false, fatal: false },
  });
  const { engine, durable } = await seededEngine({ provider, tools });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 32));

  assert.equal(executed, false);
  const failedResult = durable.records().find((record) => record.type === DurableRecordTypes.ToolResultFailed);
  assert.equal(failedResult.payload.error.code, "TOOL_SCHEMA_INVALID");
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnCompleted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
  assertEveryRequestedToolTerminated(durable.records());
});

test("malformed policy-modified tool input fails the call and continues to the next provider step", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call-complete", call: { callId: "native", name: "read", input: { path: "README.md" } } },
      { type: "completed", reason: "tool-use" },
    ],
    [
      { type: "text-delta", text: "retryable" },
      { type: "completed", reason: "complete" },
    ],
  ]);
  let executed = false;
  const tools = new MemoryToolExecutor(() => {
    executed = true;
    return completed("should not run");
  });
  tools.validate = ({ input }) =>
    input.path === "README.md"
      ? { ok: true, input }
      : {
          ok: false,
          error: { code: "TOOL_SCHEMA_INVALID", message: "path is required", retryable: false, fatal: false },
        };
  const policy = new StaticPolicy({ kind: "allow-modified", input: { offset: 1 } });
  const { engine, durable } = await seededEngine({ provider, policy, tools });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 33));

  assert.equal(executed, false);
  const request = durable.records().find((record) => record.type === DurableRecordTypes.ToolRequested);
  const failedResult = durable.records().find((record) => record.type === DurableRecordTypes.ToolResultFailed);
  assert.deepEqual(request.payload.input, { offset: 1 });
  assert.equal(failedResult.payload.error.code, "TOOL_SCHEMA_INVALID");
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
  const { engine, durable } = await seededEngine();
  const submit = command(CommandTypes.TurnSubmit, { input: "once" }, { turnId: ids.turnId }, 7, "turn-submit-once");

  const first = await engine.submit(submit);
  const second = await engine.submit({ ...submit, commandId: formatCommandId(uuid(999)) });

  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "duplicate");
  assert.deepEqual(second.records, first.records);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("idempotency keys are scoped to a conversation and command type", async () => {
  const { engine, durable } = await seededEngine();
  const firstConversation = formatConversationId(uuid(61));
  const secondConversation = formatConversationId(uuid(62));
  const first = await engine.submit(
    command(
      CommandTypes.ConversationCreate,
      { title: "First" },
      { conversationId: firstConversation },
      61,
      "shared-key",
    ),
  );
  const second = await engine.submit(
    command(
      CommandTypes.ConversationCreate,
      { title: "Second" },
      { conversationId: secondConversation },
      62,
      "shared-key",
    ),
  );
  const conflict = await engine.submit(
    command(
      CommandTypes.TurnCancel,
      { reason: "different type" },
      { conversationId: firstConversation, turnId: ids.turnId },
      63,
      "shared-key",
    ),
  );

  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  assert.deepEqual(conflict, {
    kind: "rejected",
    code: "IDEMPOTENCY_CONFLICT",
    message: "Idempotency key was already used for a different command type",
  });
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
});

test("a rejected command does not reserve its idempotency key", async () => {
  const { engine, durable } = await seededEngine();
  const rejected = await engine.submit(
    command(CommandTypes.TurnCancel, { reason: "too early" }, { turnId: ids.turnId }, 64, "reusable-key"),
  );
  const accepted = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "now start" }, { turnId: ids.turnId }, 65, "reusable-key"),
  );

  assert.equal(rejected.kind, "rejected");
  assert.equal(accepted.kind, "accepted");
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
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
