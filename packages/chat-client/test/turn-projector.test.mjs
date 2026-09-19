import assert from "node:assert/strict";
import test from "node:test";
import { composeConversationPresentation, interpretShellCommand } from "../dist/index.js";

const base = { sessionId: "sess_1", turnId: "turn_1" };
const user = { kind: "user-message", key: "u:turn_1", ...base, order: [0, 3, 0], text: "Fix it", source: "durable" };
const call = (id, name, detail, order) => ({
  toolCallId: id,
  name,
  input: {},
  status: "completed",
  headline: name,
  detail,
  requiresApproval: false,
  synthetic: false,
  progress: [],
  durationMs: 4,
  providerOrder: order,
});

test("one user request composes ordered agent steps, distinct calls, final response, and one outcome", () => {
  const view = {
    conversationId: "conv_1",
    diagnostics: [],
    items: [
      user,
      {
        kind: "assistant-message",
        key: "a:step_1",
        ...base,
        stepId: "step_1",
        order: [0, 4, 0],
        text: "I will inspect it.",
        source: "durable",
        streaming: false,
      },
      {
        kind: "tool-activity",
        key: "t:step_1",
        ...base,
        stepId: "step_1",
        order: [0, 5, 0],
        summary: "Read 2 files",
        status: "completed",
        calls: [
          call("tool_1", "read", { presentation: "file-read", path: "a.ts" }, 0),
          call("tool_2", "read", { presentation: "file-read", path: "a.ts" }, 1),
        ],
      },
      {
        kind: "assistant-message",
        key: "a:step_2",
        ...base,
        stepId: "step_2",
        order: [0, 8, 0],
        text: "Fixed the test.",
        source: "durable",
        streaming: false,
      },
      {
        kind: "turn-status",
        key: "st:turn_1",
        ...base,
        order: [0, 9, 0],
        status: "completed",
      },
    ],
  };
  const result = composeConversationPresentation(view);
  assert.equal(result.timeline.length, 1);
  const turn = result.timeline[0];
  assert.equal(turn.kind, "turn");
  assert.equal(turn.steps.length, 1);
  assert.equal(turn.steps[0].stepId, "step_1");
  assert.deepEqual(
    turn.steps[0].actions.map((action) => action.toolCallId),
    ["tool_1", "tool_2"],
  );
  assert.equal(turn.finalResponse.stepId, "step_2");
  assert.equal(turn.outcome.status, "completed");
});

test("a pending approval is owned by its action and referenced by its turn", () => {
  const tool = {
    ...call("tool_1", "shell", { presentation: "shell", command: "pnpm test", truncated: false }, 0),
    status: "awaiting-approval",
    approval: { approvalId: "appr_1", reason: "Run tests", status: "pending" },
  };
  const approval = {
    kind: "approval-request",
    key: "ap:appr_1",
    ...base,
    stepId: "step_1",
    toolCallId: "tool_1",
    approvalId: "appr_1",
    order: [0, 6, 0],
    reason: "Run tests",
    tool,
  };
  const result = composeConversationPresentation({
    conversationId: "conv_1",
    diagnostics: [],
    items: [
      user,
      {
        kind: "tool-activity",
        key: "t:step_1",
        ...base,
        stepId: "step_1",
        order: [0, 5, 0],
        summary: "Run command",
        status: "awaiting-approval",
        calls: [tool],
      },
      approval,
    ],
  });
  const turn = result.timeline[0];
  assert.equal(turn.blockingApproval, approval);
  assert.equal(turn.steps[0].actions[0].approval, approval);
});

test("command interpretation recognizes only unambiguous shapes and falls back for compound shell", () => {
  assert.deepEqual(interpretShellCommand("pnpm test"), { kind: "test-run", label: "Running tests" });
  assert.deepEqual(interpretShellCommand('rg "createSession" packages'), {
    kind: "repository-search",
    label: "Searching the repository",
  });
  assert.equal(interpretShellCommand("rg foo . && rm -rf tmp"), undefined);
  assert.equal(interpretShellCommand("custom-runner --mode test"), undefined);
});
