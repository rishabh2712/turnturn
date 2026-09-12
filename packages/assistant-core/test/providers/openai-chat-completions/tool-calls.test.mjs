import assert from "node:assert/strict";
import test from "node:test";
import { ChatToolCallAssembler } from "../../../dist/providers/openai-chat-completions/tool-calls.js";

test("tool call assembler emits start exactly once when a gateway repeats the id", () => {
  const assembler = new ChatToolCallAssembler();

  const first = assembler.merge({
    index: 0,
    callId: "call_1",
    name: "read",
    argumentsDelta: '{"path":',
  });
  const second = assembler.merge({
    index: 0,
    callId: "call_1",
    name: "",
    argumentsDelta: '"README.md"}',
  });

  assert.deepEqual(first, [
    { type: "tool-call-start", callId: "call_1", name: "read" },
    { type: "tool-call-arguments-delta", callId: "call_1", text: '{"path":' },
  ]);
  assert.deepEqual(second, [{ type: "tool-call-arguments-delta", callId: "call_1", text: '"README.md"}' }]);
});

test("tool call assembler upgrades a synthetic provisional id when the real id arrives later", () => {
  const assembler = new ChatToolCallAssembler();

  assert.deepEqual(
    assembler.merge({
      index: 0,
      callId: undefined,
      name: "read",
      argumentsDelta: '{"path":',
    }),
    [],
  );
  assert.deepEqual(
    assembler.merge({
      index: 0,
      callId: "call_real",
      name: "",
      argumentsDelta: '"README.md"}',
    }),
    [
      { type: "tool-call-start", callId: "call_real", name: "read" },
      { type: "tool-call-arguments-delta", callId: "call_real", text: '{"path":"README.md"}' },
    ],
  );

  assert.deepEqual(assembler.completedCalls(), {
    ok: true,
    calls: [{ callId: "call_real", name: "read", input: { path: "README.md" } }],
  });
});

test("tool call assembler rejects completion when the provider never supplies an id", () => {
  const assembler = new ChatToolCallAssembler();

  assembler.merge({
    index: 0,
    callId: undefined,
    name: "read",
    argumentsDelta: '{"path":"README.md"}',
  });

  assert.deepEqual(assembler.completedCalls(), {
    ok: false,
    message: "Tool call completed without a provider id",
  });
});
