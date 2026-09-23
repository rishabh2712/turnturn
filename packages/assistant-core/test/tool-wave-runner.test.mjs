import assert from "node:assert/strict";
import test from "node:test";
import { CommandTypes, formatCommandId, formatConversationId, formatSessionId, formatTurnId } from "@turnturn/protocol";
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

async function seededEngine({ provider, policy, tools, observation } = {}) {
  const durable = new MemoryDurableSink();
  const live = new MemoryLiveSink();
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

  const { planNextWave } = await import("../dist/wave-planner.js");

  const calls = [
    { callId: "1", name: "read", input: { path: "a.txt" } },
    { callId: "2", name: "custom-tool", input: {} },
    { callId: "3", name: "read", input: { path: "c.txt" } },
  ];

  const plan = planNextWave(calls, port);
  assert.equal(plan.wave.length, 1, "wave should stop before unknown tool");
  assert.deepEqual(plan.remaining, [calls[1], calls[2]], "remaining should have unknown and later read");
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
