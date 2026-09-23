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
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { createAssistantEngine } from "../dist/engine.js";
import {
  completed,
  FixedClock,
  MemoryDurableSink,
  MemoryLiveSink,
  MemoryToolExecutor,
  ScriptedProvider,
  SequentialIds,
  StaticPolicy,
} from "../dist/testing.js";

const uuid = (n) => `018f1f4e-8d5f-7abc-8123-823456789${String(n).padStart(3, "0")}`;
const ids = {
  conversationId: formatConversationId(uuid(1)),
  sessionId: formatSessionId(uuid(2)),
  turnId: formatTurnId(uuid(3)),
};

function command(type, payload, scope = {}, n = 1) {
  return {
    schemaVersion: 1,
    commandId: formatCommandId(uuid(100 + n)),
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    payload,
    ...scope,
  };
}

async function seededEngine({
  provider,
  policy,
  tools,
  observation,
  durable = new MemoryDurableSink(),
  live = new MemoryLiveSink(),
} = {}) {
  const engine = createAssistantEngine({
    provider: provider ?? new ScriptedProvider([[{ type: "completed", reason: "complete" }]]),
    policy: policy ?? new StaticPolicy(),
    tools: tools ?? new MemoryToolExecutor(() => completed("ok")),
    durable,
    live,
    ids: new SequentialIds(),
    clock: new FixedClock(),
    ...(observation === undefined ? {} : { observation }),
  });

  await engine.submit(command(CommandTypes.ConversationCreate, { title: "Demo" }, {}, 1));
  await engine.submit(command(CommandTypes.SessionCreate, { provider: "scripted" }, {}, 2));
  return { engine, durable, live };
}

const readDefinitions = [{ name: "read", description: "Read a file", parameters: {}, mutating: false }];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function toolCall(callId, path) {
  return { type: "tool-call-complete", call: { callId, name: "read", input: { path } } };
}

function terminalFor(records, callId) {
  const request = records.find(
    (record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === callId,
  );
  return records.find(
    (record) =>
      record.toolCallId === request?.toolCallId &&
      [
        DurableRecordTypes.ToolResultCompleted,
        DurableRecordTypes.ToolResultFailed,
        DurableRecordTypes.ToolResultDenied,
        DurableRecordTypes.ToolResultAborted,
      ].includes(record.type),
  );
}

test("a read approval opens only after earlier read result is durable", async () => {
  const approvalWritten = deferred();
  class ApprovalNotifyingSink extends MemoryDurableSink {
    async append(draft) {
      const record = await super.append(draft);
      if (record.type === DurableRecordTypes.ApprovalRequested) approvalWritten.resolve(record);
      return record;
    }
  }
  const durable = new ApprovalNotifyingSink();
  const policy = {
    async decide(request) {
      return request.input.path === "b" ? { kind: "ask", reason: "read b" } : { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor((request) => completed(request.input.path), readDefinitions);
  const { engine } = await seededEngine({
    durable,
    policy,
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const running = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 80));
  const approval = await Promise.race([
    approvalWritten.promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `approval not opened: ${durable
                .records()
                .map((record) => record.type)
                .join(", ")}`,
            ),
          ),
        1000,
      ),
    ),
  ]);
  const priorResult = terminalFor(durable.records(), "a");
  let approvalOutcome;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    approvalOutcome = await engine.submit(
      command(
        CommandTypes.ApprovalResolve,
        { decision: ApprovalDecisions.Allow },
        { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
        81 + attempt,
      ),
    );
    if (approvalOutcome.kind === "accepted") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(approvalOutcome.kind, "accepted");
  await running;

  assert.ok(priorResult, "earlier read must terminate before approval.requested");
  assert.ok(priorResult.sequence < approval.sequence);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("an approval can be resolved immediately when its live request is published", async () => {
  const firstResolution = deferred();
  class ResolvingLiveSink extends MemoryLiveSink {
    engine;

    publish(event) {
      super.publish(event);
      if (event.type !== "approval.requested") return;
      const resolve = (n) =>
        this.engine.submit(
          command(
            CommandTypes.ApprovalResolve,
            { decision: ApprovalDecisions.Allow },
            { turnId: ids.turnId, toolCallId: event.toolCallId, approvalId: event.approvalId },
            n,
          ),
        );
      void resolve(90).then((outcome) => {
        firstResolution.resolve(outcome);
        // Let the old implementation finish, so the test fails rather than hanging.
        if (outcome.kind !== "accepted") setImmediate(() => void resolve(91));
      });
    }
  }
  const live = new ResolvingLiveSink();
  const { engine, durable } = await seededEngine({
    live,
    policy: new StaticPolicy({ kind: "ask", reason: "read" }),
    tools: new MemoryToolExecutor(() => completed("ok"), readDefinitions),
    provider: new ScriptedProvider([
      [toolCall("a", "a"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });
  live.engine = engine;
  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 89));

  assert.equal((await firstResolution.promise).kind, "accepted");
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("a denied read cannot overtake an earlier queued read result", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const policy = {
    async decide(request) {
      return request.input.path === "b"
        ? { kind: "deny", error: { code: "DENIED", message: "denied", retryable: false, fatal: false } }
        : { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor(async (request) => {
    if (request.input.path === "a") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return completed(request.input.path);
  }, readDefinitions);
  const { engine, durable } = await seededEngine({
    policy,
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const running = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 82));
  await firstStarted.promise;
  const prematureDenial = terminalFor(durable.records(), "b");
  releaseFirst.resolve();
  await running;

  assert.equal(prematureDenial, undefined, "later denial must wait for the earlier read");
  assert.ok(terminalFor(durable.records(), "a").sequence < terminalFor(durable.records(), "b").sequence);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("policy failure terminates earlier requested reads before turn.failed", async () => {
  const policy = {
    async decide(request) {
      if (request.input.path === "b") throw new Error("policy unavailable");
      return { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor(() => completed("ok"), readDefinitions);
  const { engine, durable } = await seededEngine({
    policy,
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
    ]),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 83));
  const terminal = terminalFor(durable.records(), "a");
  const turnFailed = durable.records().find((record) => record.type === DurableRecordTypes.TurnFailed);
  assert.ok(terminal, "earlier requested read must terminate");
  assert.ok(terminal.sequence < turnFailed.sequence);
  assert.equal(terminal.type, DurableRecordTypes.ToolResultAborted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("validation exception terminates earlier requests without disguising it as a tool failure", async () => {
  const tools = new MemoryToolExecutor(() => completed("ok"), readDefinitions);
  tools.validate = ({ input }) => {
    if (input.path === "b") throw new Error("validator unavailable");
    return { ok: true, input };
  };
  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
    ]),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 102));
  const records = durable.records();
  const aResult = terminalFor(records, "a");
  const turnFailed = records.find((record) => record.type === DurableRecordTypes.TurnFailed);
  assert.equal(aResult?.type, DurableRecordTypes.ToolResultAborted);
  assert.ok(aResult.sequence < turnFailed.sequence);
  assert.equal(terminalFor(records, "b"), undefined);
  assert.equal(
    records.some(
      (record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === "b",
    ),
    false,
  );
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("cancellation during policy preparation does not admit a later read", async () => {
  const enteredPolicy = deferred();
  const releasePolicy = deferred();
  const policy = {
    async decide(request) {
      if (request.input.path === "b") {
        enteredPolicy.resolve();
        return await releasePolicy.promise;
      }
      return { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor(() => completed("ok"), readDefinitions);
  const { engine, durable } = await seededEngine({
    policy,
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
    ]),
  });

  const running = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 84));
  await enteredPolicy.promise;
  const cancelling = engine.submit(command(CommandTypes.TurnCancel, { reason: "stop" }, { turnId: ids.turnId }, 85));
  releasePolicy.resolve({ kind: "allow" });
  await Promise.all([running, cancelling]);

  assert.ok(terminalFor(durable.records(), "a"));
  assert.equal(terminalFor(durable.records(), "b"), undefined);
  assert.equal(
    durable
      .records()
      .some((record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === "b"),
    false,
  );
  assert.equal(durable.records().at(-1).type, DurableRecordTypes.TurnAborted);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

test("Step 0: two independent sequential reads do not overlap today", async () => {
  // This test demonstrates the current sequential behavior where read calls
  // are executed one at a time with strict ordering.
  const executionLog = [];

  const tools = new MemoryToolExecutor(async (request) => {
    // Log by input to distinguish calls
    const path =
      typeof request.input === "object" && request.input !== null && "path" in request.input
        ? request.input.path
        : "unknown";
    executionLog.push({ event: "start", path, timestamp: Date.now() });
    // Simulate some async work
    await new Promise((r) => setTimeout(r, 10));
    executionLog.push({ event: "end", path, timestamp: Date.now() });
    return completed(`read ${path}`);
  });

  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "read1", name: "read", input: { path: "a.txt" } } },
        { type: "tool-call-complete", call: { callId: "read2", name: "read", input: { path: "b.txt" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const outcome = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "test sequential reads" }, { turnId: ids.turnId }, 70),
  );

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);

  // Verify sequential execution: a.txt must complete before b.txt starts
  const aEnd = executionLog.findIndex((e) => e.event === "end" && e.path === "a.txt");
  const bStart = executionLog.findIndex((e) => e.event === "start" && e.path === "b.txt");

  assert.ok(aEnd >= 0, "a.txt should have ended");
  assert.ok(bStart >= 0, "b.txt should have started");
  assert.ok(bStart > aEnd, "b.txt should not start before a.txt ends (sequential execution)");
});

test("Step 0: baseline test counts before parallel implementation", async () => {
  // This test just records the current state of the system
  const { engine, durable } = await seededEngine({
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "t1", name: "read", input: { path: "f.txt" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "baseline" }, { turnId: ids.turnId }, 71));

  // Verify basic engine functionality and reducer invariants
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});

// Step 0: Wave Planner Tests

test("Step 0: wave planner classifies read-only tools as waveable", async () => {
  // Access the workspace tools to get definitions
  const port = (await import("../dist/workspace-tools.js")).createWorkspaceToolExecutor({ roots: ["/tmp"] });

  const { classifyToolCall } = await import("../dist/wave-planner.js");

  const definitions = port.definitions();
  assert.ok(definitions.length > 0, "should have workspace tool definitions");

  // read, glob, grep should be waveable
  for (const name of ["read", "glob", "grep"]) {
    const call = { callId: "test", name, input: {} };
    const result = classifyToolCall(call, definitions);
    assert.equal(result.canWave, true, `${name} should be waveable`);
    assert.equal(result.isBarrier, false, `${name} should not be a barrier`);
  }

  // write, edit, shell should be barriers
  for (const name of ["write", "edit", "shell"]) {
    const call = { callId: "test", name, input: {} };
    const result = classifyToolCall(call, definitions);
    assert.equal(result.canWave, false, `${name} should not be waveable`);
    assert.equal(result.isBarrier, true, `${name} should be a barrier`);
  }
});

test("Step 0: wave planner respects four-call limit", async () => {
  const port = (await import("../dist/workspace-tools.js")).createWorkspaceToolExecutor({ roots: ["/tmp"] });

  const { planNextWave } = await import("../dist/wave-planner.js");

  const calls = [
    { callId: "1", name: "read", input: { path: "a.txt" } },
    { callId: "2", name: "read", input: { path: "b.txt" } },
    { callId: "3", name: "glob", input: { pattern: "*.ts" } },
    { callId: "4", name: "grep", input: { query: "test" } },
    { callId: "5", name: "read", input: { path: "c.txt" } },
  ];

  const plan = planNextWave(calls, port);
  assert.equal(plan.wave.length, 4, "wave should contain first 4 read-only calls");
  assert.deepEqual(plan.remaining, [calls[4]], "remaining should have the 5th call");
});

test("Step 0: wave planner stops before barriers", async () => {
  const port = (await import("../dist/workspace-tools.js")).createWorkspaceToolExecutor({ roots: ["/tmp"] });

  const { planNextWave } = await import("../dist/wave-planner.js");

  const calls = [
    { callId: "1", name: "read", input: { path: "a.txt" } },
    { callId: "2", name: "read", input: { path: "b.txt" } },
    { callId: "3", name: "write", input: { path: "c.txt", content: "x" } },
    { callId: "4", name: "read", input: { path: "d.txt" } },
  ];

  const plan = planNextWave(calls, port);
  assert.equal(plan.wave.length, 2, "wave should stop before write");
  assert.deepEqual(plan.remaining, [calls[2], calls[3]], "remaining should have write and later read");
});

test("Step 0: wave planner handles unknown tools as barriers", async () => {
  const port = (await import("../dist/workspace-tools.js")).createWorkspaceToolExecutor({ roots: ["/tmp"] });

  const { classifyToolCall, planNextWave } = await import("../dist/wave-planner.js");

  const calls = [
    { callId: "1", name: "read", input: { path: "a.txt" } },
    { callId: "2", name: "custom-tool", input: {} },
    { callId: "3", name: "read", input: { path: "c.txt" } },
  ];

  const plan = planNextWave(calls, port);
  assert.equal(plan.wave.length, 1, "wave should stop before unknown tool");
  assert.deepEqual(plan.remaining, [calls[1], calls[2]], "remaining should have unknown and later read");
  assert.equal(classifyToolCall(calls[0], []).isBarrier, true, "a read without its definition is also a barrier");
});

// Step 1: Deadline Wrapper Tests

test("Step 1: deadline wrapper enforces timeout on read-only tools", async () => {
  const { createDeadlineWrapper, validateTimeoutConfig } = await import("../dist/deadline-wrapper.js");

  // Validate configuration
  const config = validateTimeoutConfig({ defaultMs: 50, maxMs: 200 });
  assert.equal(config.defaultMs, 50, "default should be 50ms");
  assert.equal(config.maxMs, 200, "max should be 200ms");
  assert.equal(config.byTool.read, 50, "read timeout should be 50ms");

  // Create a slow tool that respects the abort signal
  const slowTool = {
    definitions: () => [{ name: "read", description: "read", parameters: {}, mutating: false }],
    validate: (req) => ({ ok: true, input: req.input }),
    execute: async (req) => {
      // Check signal and wait indefinitely if not aborted
      if (req.signal.aborted) {
        return { kind: "failed", error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false } };
      }
      // This never resolves but respects abort signal
      return new Promise((resolve) => {
        if (req.signal.aborted) {
          resolve({ kind: "failed", error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false } });
        } else {
          // Never resolves, timeout will abort
          req.signal.addEventListener("abort", () => {
            resolve({ kind: "failed", error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false } });
          });
        }
      });
    },
  };

  const wrapper = createDeadlineWrapper(slowTool, { defaultMs: 50, maxMs: 200 });

  const controller = new AbortController();
  const outcome = await wrapper.execute({
    conversationId: "c1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    name: "read",
    input: { path: "test.txt" },
    signal: controller.signal,
    callbacks: { stdout: () => {}, stderr: () => {}, progress: () => {} },
  });

  assert.equal(outcome.kind, "failed", "should fail");
  assert.equal(outcome.error.code, "TOOL_TIMEOUT", "should be TOOL_TIMEOUT error");
  assert.equal(outcome.error.fatal, false, "should not be fatal");
  assert.equal(outcome.error.retryable, false, "should not be retryable");
});

test("Step 1: deadline wrapper respects per-tool timeout overrides", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");

  const slowTool = {
    definitions: () => [{ name: "grep", description: "grep", parameters: {}, mutating: false }],
    validate: (req) => ({ ok: true, input: req.input }),
    execute: async (req) => {
      return new Promise((resolve) => {
        req.signal.addEventListener("abort", () => {
          resolve({
            kind: "failed",
            error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false },
          });
        });
      });
    },
  };

  // Override grep timeout to 30ms
  const wrapper = createDeadlineWrapper(slowTool, {
    defaultMs: 100,
    maxMs: 200,
    byTool: { grep: 30 },
  });

  const startTime = Date.now();
  const outcome = await wrapper.execute({
    conversationId: "c1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    name: "grep",
    input: { query: "test" },
    signal: new AbortController().signal,
    callbacks: { stdout: () => {}, stderr: () => {}, progress: () => {} },
  });

  const elapsed = Date.now() - startTime;
  assert.equal(outcome.kind, "failed", "should timeout");
  assert.equal(outcome.error.code, "TOOL_TIMEOUT", "should be timeout error");
  assert.ok(elapsed < 100, `should timeout around 30ms, but took ${elapsed}ms`);
});

test("Step 1: deadline wrapper suppresses callbacks after timeout", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");

  const callbackLog = [];

  const tool = {
    definitions: () => [{ name: "read", description: "read", parameters: {}, mutating: false }],
    validate: (req) => ({ ok: true, input: req.input }),
    execute: async (request) => {
      // Simulate a slow tool that tries to emit output after timeout
      const promise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          request.callbacks.stdout("late output");
          resolve({ kind: "completed", output: "result" });
        }, 100);

        request.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve({
            kind: "failed",
            error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false },
          });
        });
      });
      return promise;
    },
  };

  const wrapper = createDeadlineWrapper(tool, { defaultMs: 50, maxMs: 200 });

  const outcome = await wrapper.execute({
    conversationId: "c1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    name: "read",
    input: {},
    signal: new AbortController().signal,
    callbacks: {
      stdout: (text) => callbackLog.push({ type: "stdout", text }),
      stderr: (text) => callbackLog.push({ type: "stderr", text }),
      progress: (text) => callbackLog.push({ type: "progress", text }),
    },
  });

  assert.equal(outcome.kind, "failed", "should timeout");
  assert.equal(callbackLog.length, 0, "should not emit callbacks after timeout");
});

test("Step 1: deadline wrapper suppresses callbacks after normal settlement", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");
  const output = [];
  let lateOutput;
  const tool = {
    definitions: () => readDefinitions,
    validate: ({ input }) => ({ ok: true, input }),
    async execute(request) {
      lateOutput = () => request.callbacks.stdout("late");
      return completed("done");
    },
  };
  const wrapper = createDeadlineWrapper(tool, { defaultMs: 100, maxMs: 200 });
  const outcome = await wrapper.execute({
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    toolCallId: "tool_test",
    name: "read",
    input: { path: "a" },
    signal: new AbortController().signal,
    callbacks: { stdout: (text) => output.push(text), stderr: () => {}, progress: () => {} },
  });

  assert.equal(outcome.kind, "completed");
  lateOutput();
  assert.deepEqual(output, []);
});

test("Step 1: a timed-out read ignores late physical output and settlement", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");
  const physical = deferred();
  const output = [];
  let lateOutput;
  const tool = {
    definitions: () => readDefinitions,
    validate: ({ input }) => ({ ok: true, input }),
    execute: (request) => {
      lateOutput = () => request.callbacks.stdout("late");
      return physical.promise;
    },
  };
  const wrapper = createDeadlineWrapper(tool, { defaultMs: 20, maxMs: 100 });
  const outcome = await wrapper.execute({
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    toolCallId: "tool_test",
    name: "read",
    input: { path: "a" },
    signal: new AbortController().signal,
    callbacks: { stdout: (text) => output.push(text), stderr: () => {}, progress: () => {} },
  });

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.code, "TOOL_TIMEOUT");
  lateOutput();
  physical.resolve(completed("too late"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output, []);
  assert.equal(outcome.error.code, "TOOL_TIMEOUT");
});

test("Step 1: timeout remains the outcome if aborting the tool triggers turn cancellation", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");
  const parent = new AbortController();
  const tool = {
    definitions: () => readDefinitions,
    validate: ({ input }) => ({ ok: true, input }),
    execute: (request) => {
      request.signal.addEventListener("abort", () => parent.abort());
      return new Promise(() => {});
    },
  };
  const wrapper = createDeadlineWrapper(tool, { defaultMs: 20, maxMs: 100 });
  const outcome = await wrapper.execute({
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    toolCallId: "tool_test",
    name: "read",
    input: { path: "a" },
    signal: parent.signal,
    callbacks: { stdout: () => {}, stderr: () => {}, progress: () => {} },
  });
  assert.equal(parent.signal.aborted, true);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.code, "TOOL_TIMEOUT");
});

test("Step 1: turn cancellation settles an executor that ignores abort", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");
  const entered = deferred();
  const output = [];
  let lateOutput;
  const tool = {
    definitions: () => readDefinitions,
    validate: ({ input }) => ({ ok: true, input }),
    execute: (request) => {
      lateOutput = () => request.callbacks.stdout("late");
      entered.resolve();
      return new Promise(() => {});
    },
  };
  const wrapper = createDeadlineWrapper(tool, { defaultMs: 100, maxMs: 200 });
  const controller = new AbortController();
  const running = wrapper.execute({
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    toolCallId: "tool_test",
    name: "read",
    input: { path: "a" },
    signal: controller.signal,
    callbacks: { stdout: (text) => output.push(text), stderr: () => {}, progress: () => {} },
  });
  await entered.promise;
  controller.abort();
  const winner = await Promise.race([
    running.then(() => "cancelled"),
    new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
  ]);
  assert.equal(winner, "cancelled", "turn cancellation should not wait for the read deadline");
  const outcome = await running;
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.code, "TURN_CANCELLED");
  lateOutput();
  assert.deepEqual(output, []);
});

test("Step 1: deadline wrapper passes turn cancellation through", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");

  const tool = {
    definitions: () => [{ name: "read", description: "read", parameters: {}, mutating: false }],
    validate: (req) => ({ ok: true, input: req.input }),
    execute: async (request) => {
      return new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({
            kind: "failed",
            error: { code: "ABORTED", message: "Aborted", retryable: false, fatal: false },
          });
        });
      });
    },
  };

  const wrapper = createDeadlineWrapper(tool, { defaultMs: 50, maxMs: 200 });
  const controller = new AbortController();

  // Cancel the turn signal
  controller.abort();

  const outcome = await wrapper.execute({
    conversationId: "c1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    name: "read",
    input: {},
    signal: controller.signal,
    callbacks: { stdout: () => {}, stderr: () => {}, progress: () => {} },
  });

  // Should fail due to parent signal being aborted
  assert.equal(outcome.kind, "failed", "should fail");
});

test("Step 1: deadline wrapper validates configuration bounds", async () => {
  const { validateTimeoutConfig } = await import("../dist/deadline-wrapper.js");

  // Valid configuration
  const valid = validateTimeoutConfig({ defaultMs: 30000, maxMs: 120000 });
  assert.ok(valid, "should accept valid configuration");

  // Invalid: defaultMs > maxMs
  assert.throws(
    () => validateTimeoutConfig({ defaultMs: 100, maxMs: 50 }),
    /defaultMs.*must be.*maxMs/,
    "should reject defaultMs > maxMs",
  );

  // Invalid: non-positive defaultMs
  assert.throws(
    () => validateTimeoutConfig({ defaultMs: -100 }),
    /defaultMs.*must be a positive/,
    "should reject negative defaultMs",
  );

  // Invalid: override exceeds max
  assert.throws(
    () => validateTimeoutConfig({ defaultMs: 30, maxMs: 100, byTool: { read: 150 } }),
    /byTool.read.*must be.*maxMs/,
    "should reject override > maxMs",
  );
});

// Step 2: Execute Read-Only Waves

test("Step 2: two independent reads overlap when dispatched as a wave", async () => {
  // This test demonstrates the DESIRED behavior after wave implementation.
  // Currently it shows reads execute sequentially.
  // After Step 2, independent reads should execute concurrently.

  const executionLog = [];
  const startTime = Date.now();

  const tools = new MemoryToolExecutor(
    async (request) => {
      const path =
        typeof request.input === "object" && request.input !== null && "path" in request.input
          ? request.input.path
          : "unknown";
      const elapsed = Date.now() - startTime;

      executionLog.push({ event: "start", path, elapsed });

      // Simulate realistic I/O delay for each read
      await new Promise((r) => setTimeout(r, 50));

      executionLog.push({ event: "end", path, elapsed: Date.now() - startTime });
      return completed(`read ${path}`);
    },
    [
      { name: "read", description: "Read a file", parameters: {}, mutating: false },
      { name: "glob", description: "Glob files", parameters: {}, mutating: false },
      { name: "grep", description: "Search files", parameters: {}, mutating: false },
    ],
  );

  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [
        { type: "tool-call-complete", call: { callId: "read1", name: "read", input: { path: "a.txt" } } },
        { type: "tool-call-complete", call: { callId: "read2", name: "read", input: { path: "b.txt" } } },
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const outcome = await engine.submit(
    command(CommandTypes.TurnSubmit, { input: "test wave execution" }, { turnId: ids.turnId }, 70),
  );

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);

  // Find the execution intervals
  const aStart = executionLog.find((e) => e.event === "start" && e.path === "a.txt")?.elapsed ?? 0;
  const bEnd = executionLog.find((e) => e.event === "end" && e.path === "b.txt")?.elapsed ?? 0;

  // For wave execution: reads should overlap
  // a.txt: [start: ~0, end: ~50]
  // b.txt: [start: ~0-5, end: ~50-55] (starts before a finishes)
  // Total time should be ~50-55ms, not ~100ms

  const totalTime = bEnd - aStart;

  // This test is EXPECTED TO FAIL now (sequential = ~100ms)
  // After Step 2, it should PASS (parallel = ~50-55ms)
  assert.ok(
    totalTime < 75,
    `reads should overlap in wave execution (~50-55ms), not sequential (~100ms). Actual: ${totalTime}ms`,
  );
});

test("Step 1: deadline wrapper settles on deadline even if executor ignores abort", async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");

  // Misbehaving executor that ignores abort signal and returns late
  const stubbornTool = {
    definitions: () => [{ name: "read", description: "read", parameters: {}, mutating: false }],
    validate: (req) => ({ ok: true, input: req.input }),
    execute: async (_request) => {
      // Intentionally ignore the abort signal and return after 200ms
      return new Promise((resolve) => {
        setTimeout(() => {
          // This resolve happens AFTER the deadline, but wrapper should not use this result
          resolve({ kind: "completed", output: "stubborn result" });
        }, 200);
      });
    },
  };

  const wrapper = createDeadlineWrapper(stubbornTool, { defaultMs: 50, maxMs: 200 });

  const startTime = Date.now();
  const outcome = await wrapper.execute({
    conversationId: "c1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    name: "read",
    input: {},
    signal: new AbortController().signal,
    callbacks: { stdout: () => {}, stderr: () => {}, progress: () => {} },
  });

  const elapsed = Date.now() - startTime;

  // Verify wrapper returned timeout error, not executor's late result
  assert.equal(outcome.kind, "failed", "wrapper should return failed");
  assert.equal(outcome.error.code, "TOOL_TIMEOUT", "should be TOOL_TIMEOUT error");

  // Verify wrapper settled quickly, not at 200ms
  assert.ok(elapsed < 150, `wrapper should settle ~50ms, not wait for executor's 200ms (actual: ${elapsed}ms)`);
});

test("reads overlap but cannot cross an edit barrier", async () => {
  const aStarted = deferred();
  const bStarted = deferred();
  const bFinished = deferred();
  const editStarted = deferred();
  const dStarted = deferred();

  const releaseA = deferred();
  const releaseB = deferred();
  const releaseEdit = deferred();

  const starts = [];
  const tools = new MemoryToolExecutor(
    async (request) => {
      const path = request.input.path;
      starts.push(path);

      if (path === "a") {
        aStarted.resolve();
        await releaseA.promise;
      } else if (path === "b") {
        bStarted.resolve();
        await releaseB.promise;
        bFinished.resolve();
      } else if (path === "c") {
        editStarted.resolve();
        await releaseEdit.promise;
      } else if (path === "d") {
        dStarted.resolve();
      }

      return completed(path);
    },
    [
      { name: "read", description: "Read", parameters: {}, mutating: false },
      { name: "edit", description: "Edit", parameters: {}, mutating: true },
    ],
  );

  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [
        toolCall("a", "a"),
        toolCall("b", "b"),
        {
          type: "tool-call-complete",
          call: {
            callId: "c",
            name: "edit",
            input: { path: "c" },
          },
        },
        toolCall("d", "d"),
        { type: "completed", reason: "tool-use" },
      ],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "work" }, { turnId: ids.turnId }, 92));

  // A and B must both start without either being released.
  await Promise.all([aStarted.promise, bStarted.promise]);
  assert.deepEqual(starts, ["a", "b"]);

  // Even after B finishes, C cannot start while A is still running.
  releaseB.resolve();
  await bFinished.promise;
  assert.equal(starts.includes("c"), false);

  releaseA.resolve();
  await editStarted.promise;
  assert.equal(starts.includes("d"), false);

  releaseEdit.resolve();
  await dStarted.promise;
  await turn;

  const records = durable.records();
  const aResult = terminalFor(records, "a");
  const bResult = terminalFor(records, "b");
  const cResult = terminalFor(records, "c");
  const dRequest = records.find(
    (record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === "d",
  );

  assert.ok(aResult && bResult && cResult && dRequest);
  assert.ok(aResult.sequence < bResult.sequence); // Provider order, despite B finishing first
  assert.ok(bResult.sequence < cResult.sequence);
  assert.ok(cResult.sequence < dRequest.sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("an executor throw fails only that read", { timeout: 2000 }, async () => {
  const aStarted = deferred();
  const releaseA = deferred();
  const bEntered = deferred();
  const tools = new MemoryToolExecutor(async (request) => {
    if (request.input.path === "a") {
      aStarted.resolve();
      await releaseA.promise;
      return completed("A succeeded");
    }
    bEntered.resolve();
    throw new Error("B executor crashed");
  }, readDefinitions);
  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read both" }, { turnId: ids.turnId }, 94));
  await Promise.all([aStarted.promise, bEntered.promise]);
  releaseA.resolve();
  await turn;

  const records = durable.records();
  const aResult = terminalFor(records, "a");
  const bResult = terminalFor(records, "b");
  assert.equal(aResult?.type, DurableRecordTypes.ToolResultCompleted);
  assert.equal(bResult?.type, DurableRecordTypes.ToolResultFailed);
  assert.equal(bResult.payload.error.code, "TOOL_EXECUTOR_THROWN");
  assert.ok(aResult.sequence < bResult.sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("one timed-out read preserves its successful sibling", { timeout: 2000 }, async () => {
  const { createDeadlineWrapper } = await import("../dist/deadline-wrapper.js");
  const rawTools = new MemoryToolExecutor(
    (request) => (request.input.path === "a" ? completed("A succeeded") : new Promise(() => {})),
    readDefinitions,
  );
  const tools = createDeadlineWrapper(rawTools, { defaultMs: 20, maxMs: 100 });
  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read both" }, { turnId: ids.turnId }, 95));
  const records = durable.records();
  const aResult = terminalFor(records, "a");
  const bResult = terminalFor(records, "b");
  assert.equal(aResult?.type, DurableRecordTypes.ToolResultCompleted);
  assert.equal(bResult?.type, DurableRecordTypes.ToolResultFailed);
  assert.equal(bResult.payload.error.code, "TOOL_TIMEOUT");
  assert.ok(aResult.sequence < bResult.sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("allow-modified input is revalidated before joining a read wave", { timeout: 2000 }, async () => {
  const validated = [];
  const executed = [];
  const tools = new MemoryToolExecutor((request) => {
    executed.push(request.input.path);
    return completed(request.input.path);
  }, readDefinitions);
  tools.validate = ({ input }) => {
    validated.push(input.path);
    return { ok: true, input };
  };
  const policy = {
    async decide(request) {
      return request.input.path === "b" ? { kind: "allow-modified", input: { path: "b-updated" } } : { kind: "allow" };
    },
  };
  const { engine, durable } = await seededEngine({
    tools,
    policy,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  await engine.submit(command(CommandTypes.TurnSubmit, { input: "read both" }, { turnId: ids.turnId }, 96));
  const records = durable.records();
  const bRequest = records.find(
    (record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === "b",
  );
  assert.deepEqual(validated, ["a", "b", "b-updated"]);
  assert.deepEqual(executed, ["a", "b-updated"]);
  assert.deepEqual(bRequest?.payload.input, { path: "b-updated" });
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("a denied read is a barrier before a later read", { timeout: 2000 }, async () => {
  const aStarted = deferred();
  const releaseA = deferred();
  const started = [];
  const tools = new MemoryToolExecutor(async (request) => {
    started.push(request.input.path);
    if (request.input.path === "a") {
      aStarted.resolve();
      await releaseA.promise;
    }
    return completed(request.input.path);
  }, readDefinitions);
  const policy = {
    async decide(request) {
      return request.input.path === "b"
        ? { kind: "deny", error: { code: "POLICY_DENIED", message: "no", retryable: false, fatal: false } }
        : { kind: "allow" };
    },
  };
  const { engine, durable } = await seededEngine({
    tools,
    policy,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), toolCall("c", "c"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 97));
  await aStarted.promise;
  assert.deepEqual(started, ["a"]);
  releaseA.resolve();
  await turn;

  const records = durable.records();
  assert.equal(terminalFor(records, "b")?.type, DurableRecordTypes.ToolResultDenied);
  assert.deepEqual(started, ["a", "c"]);
  assert.ok(terminalFor(records, "a").sequence < terminalFor(records, "b").sequence);
  assert.ok(terminalFor(records, "b").sequence < terminalFor(records, "c").sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("policy abort drains the earlier wave and does not admit a later read", { timeout: 2000 }, async () => {
  const aStarted = deferred();
  const releaseA = deferred();
  const tools = new MemoryToolExecutor(async (request) => {
    if (request.input.path === "a") {
      aStarted.resolve();
      await releaseA.promise;
    }
    return completed(request.input.path);
  }, readDefinitions);
  const policy = {
    async decide(request) {
      return request.input.path === "b"
        ? { kind: "abort", error: { code: "POLICY_ABORT", message: "stop", retryable: false, fatal: false } }
        : { kind: "allow" };
    },
  };
  const { engine, durable } = await seededEngine({
    tools,
    policy,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), toolCall("c", "c"), { type: "completed", reason: "tool-use" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 98));
  await aStarted.promise;
  releaseA.resolve();
  await turn;

  const records = durable.records();
  assert.equal(terminalFor(records, "a")?.type, DurableRecordTypes.ToolResultCompleted);
  assert.equal(terminalFor(records, "b")?.type, DurableRecordTypes.ToolResultAborted);
  assert.equal(
    records.some(
      (record) => record.type === DurableRecordTypes.ToolRequested && record.payload.providerToolCallId === "c",
    ),
    false,
  );
  assert.equal(records.at(-1).type, DurableRecordTypes.TurnAborted);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("one failed read does not cancel its sibling", { timeout: 2000 }, async () => {
  const aStarted = deferred();
  const releaseA = deferred();
  const bFinished = deferred();

  const tools = new MemoryToolExecutor(async (request) => {
    if (request.input.path === "a") {
      aStarted.resolve();
      await releaseA.promise;
      return completed("A succeeded");
    }

    bFinished.resolve();
    return {
      kind: "failed",
      error: {
        code: "READ_FAILED",
        message: "B could not be read",
        retryable: false,
        fatal: false,
      },
    };
  }, readDefinitions);

  const { engine, durable } = await seededEngine({
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read both" }, { turnId: ids.turnId }, 93));

  await Promise.all([aStarted.promise, bFinished.promise]);
  releaseA.resolve();
  await turn;

  const records = durable.records();
  const aResult = terminalFor(records, "a");
  const bResult = terminalFor(records, "b");

  assert.equal(aResult?.type, DurableRecordTypes.ToolResultCompleted);
  assert.equal(bResult?.type, DurableRecordTypes.ToolResultFailed);
  assert.ok(aResult.sequence < bResult.sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("an approval-required read separates earlier and later reads", { timeout: 2000 }, async () => {
  const approvalVisible = deferred();
  const bStarted = deferred();
  const releaseB = deferred();
  const executed = [];
  class ApprovalLiveSink extends MemoryLiveSink {
    publish(event) {
      super.publish(event);
      if (event.type === "approval.requested") approvalVisible.resolve(event);
    }
  }
  const policy = {
    async decide(request) {
      return request.input.path === "b" ? { kind: "ask", reason: "approve B" } : { kind: "allow" };
    },
  };
  const tools = new MemoryToolExecutor(async (request) => {
    const path = request.input.path;
    executed.push(path);
    if (path === "b") {
      bStarted.resolve();
      await releaseB.promise;
    }
    return completed(path);
  }, readDefinitions);
  const { engine, durable } = await seededEngine({
    live: new ApprovalLiveSink(),
    policy,
    tools,
    provider: new ScriptedProvider([
      [toolCall("a", "a"), toolCall("b", "b"), toolCall("c", "c"), { type: "completed", reason: "tool-use" }],
      [{ type: "completed", reason: "complete" }],
    ]),
  });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read" }, { turnId: ids.turnId }, 99));
  const approval = await approvalVisible.promise;
  assert.deepEqual(executed, ["a"]);
  const approvalRecord = durable
    .records()
    .find(
      (record) => record.type === DurableRecordTypes.ApprovalRequested && record.approvalId === approval.approvalId,
    );
  assert.ok(terminalFor(durable.records(), "a").sequence < approvalRecord.sequence);
  const resolution = await engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      { decision: ApprovalDecisions.Allow },
      { turnId: ids.turnId, toolCallId: approval.toolCallId, approvalId: approval.approvalId },
      100,
    ),
  );
  assert.equal(resolution.kind, "accepted");
  await bStarted.promise;
  assert.deepEqual(executed, ["a", "b"]);
  releaseB.resolve();
  await turn;

  const records = durable.records();
  assert.deepEqual(executed, ["a", "b", "c"]);
  assert.ok(terminalFor(records, "b").sequence < terminalFor(records, "c").sequence);
  assert.deepEqual(reduceEngineState(records).issues, []);
  assert.deepEqual(reduceProviderHistory(records).issues, []);
});

test("the next provider step receives both parallel read results paired by call id", { timeout: 2000 }, async () => {
  const aStarted = deferred();
  const bStarted = deferred();
  const releaseA = deferred();
  const releaseB = deferred();
  const tools = new MemoryToolExecutor(async (request) => {
    if (request.input.path === "a") {
      aStarted.resolve();
      await releaseA.promise;
    } else {
      bStarted.resolve();
      await releaseB.promise;
    }
    return completed(request.input.path.toUpperCase());
  }, readDefinitions);
  const provider = new ScriptedProvider([
    [toolCall("a", "a"), toolCall("b", "b"), { type: "completed", reason: "tool-use" }],
    [{ type: "completed", reason: "complete" }],
  ]);
  const { engine, durable } = await seededEngine({ tools, provider });

  const turn = engine.submit(command(CommandTypes.TurnSubmit, { input: "read both" }, { turnId: ids.turnId }, 101));
  await Promise.all([aStarted.promise, bStarted.promise]);
  releaseB.resolve();
  releaseA.resolve();
  await turn;

  const history = provider.requests[1].history;
  const requests = history.items.filter((item) => item.type === "tool.request");
  const results = history.items.filter((item) => item.type === "tool.result");
  assert.deepEqual(
    requests.map((item) => item.providerToolCallId),
    ["a", "b"],
  );
  assert.deepEqual(
    results.map((item) => item.toolCallId),
    requests.map((item) => item.toolCallId),
  );
  assert.deepEqual(
    results.map((item) => item.output),
    ["A", "B"],
  );
  assert.deepEqual(history.issues, []);
  assert.deepEqual(reduceEngineState(durable.records()).issues, []);
  assert.deepEqual(reduceProviderHistory(durable.records()).issues, []);
});
