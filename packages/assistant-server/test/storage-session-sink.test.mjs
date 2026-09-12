import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantEngine } from "@turnturn/assistant-core";
import {
  completed,
  FixedClock,
  MemoryLiveSink,
  MemoryToolExecutor,
  ScriptedProvider,
  SequentialIds,
  StaticPolicy,
} from "@turnturn/assistant-core/testing";
import {
  CommandTypes,
  DurableRecordTypes,
  formatApprovalId,
  formatCommandId,
  formatConversationId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { JsonlSessionDurableSink } from "../dist/storage/session-sink.js";

test("one session log survives reopen with identical records and clean reductions", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-sink-test-"));
  const conversationId = formatConversationId(randomUUID());
  const sessionId = formatSessionId(randomUUID());
  const turnId = formatTurnId(randomUUID());
  const path = join(root, `000001-${sessionId}.jsonl`);
  try {
    const sink = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    const engine = createAssistantEngine({
      durable: sink,
      live: new MemoryLiveSink(),
      ids: new SequentialIds(),
      clock: new FixedClock(),
      provider: new ScriptedProvider([
        [
          { type: "text-delta", text: "hello" },
          { type: "completed", reason: "complete" },
        ],
      ]),
      policy: new StaticPolicy(),
      tools: new MemoryToolExecutor(() => completed("unused")),
    });
    await engine.submit(command(CommandTypes.ConversationCreate, { conversationId, sessionId }, {}));
    await engine.submit(command(CommandTypes.SessionCreate, { conversationId, sessionId }, { provider: "scripted" }));
    await engine.submit(
      command(CommandTypes.TurnSubmit, { conversationId, sessionId, turnId }, { input: "say hello" }),
    );
    const before = await readFile(path, "utf8");

    const reopened = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(reopened.records(), sink.records());
    assert.deepEqual(
      reopened.records().map((record) => record.sequence),
      Array.from({ length: reopened.records().length }, (_, index) => index + 1),
    );
    assert.deepEqual(
      reopened
        .records()
        .slice(0, 2)
        .map((record) => record.type),
      ["conversation.created", "session.created"],
    );
    assert.deepEqual(reduceEngineState(reopened.records()).issues, []);
    assert.deepEqual(reduceProviderHistory(reopened.records()).issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a torn final line is backed up, removed, and leaves the next sequence usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-sink-test-"));
  const conversationId = formatConversationId(randomUUID());
  const sessionId = formatSessionId(randomUUID());
  const path = join(root, `000001-${sessionId}.jsonl`);
  try {
    const sink = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    await sink.append(header(DurableRecordTypes.ConversationCreated, conversationId, sessionId));
    await sink.append(header(DurableRecordTypes.SessionCreated, conversationId, sessionId));
    await appendFile(path, '{"schemaVersion":1,"recordId":');
    const damaged = await readFile(path, "utf8");

    const reopened = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    const backup = (await readdir(root)).find((name) => name.includes(".corrupt-"));
    assert.ok(backup);
    assert.equal(await readFile(join(root, backup), "utf8"), damaged);
    assert.deepEqual(
      reopened.records().map((record) => record.sequence),
      [1, 2],
    );
    const appended = await reopened.append(
      header(DurableRecordTypes.TurnStarted, conversationId, sessionId, {
        turnId: formatTurnId(randomUUID()),
        payload: { input: "next" },
      }),
    );
    assert.equal(appended.sequence, 3);
    assert.deepEqual(reduceEngineState(reopened.records()).issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("middle corruption is refused without modifying the log or another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-sink-test-"));
  const conversationId = formatConversationId(randomUUID());
  const sessionId = formatSessionId(randomUUID());
  const path = join(root, `000001-${sessionId}.jsonl`);
  const otherSessionId = formatSessionId(randomUUID());
  const otherPath = join(root, `000002-${otherSessionId}.jsonl`);
  try {
    const sink = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    await sink.append(header(DurableRecordTypes.ConversationCreated, conversationId, sessionId));
    await appendFile(path, "not json\n");
    await appendFile(path, `${JSON.stringify({ still: "after corruption" })}\n`);
    const damaged = await readFile(path, "utf8");
    await assert.rejects(JsonlSessionDurableSink.open({ path, conversationId, sessionId }), /invalid session log/i);
    assert.equal(await readFile(path, "utf8"), damaged);
    const other = await JsonlSessionDurableSink.open({ path: otherPath, conversationId, sessionId: otherSessionId });
    const record = await other.append(header(DurableRecordTypes.ConversationCreated, conversationId, otherSessionId));
    assert.equal(record.sequence, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening an interrupted turn repairs tool, step, then turn exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-sink-test-"));
  const conversationId = formatConversationId(randomUUID());
  const sessionId = formatSessionId(randomUUID());
  const turnId = formatTurnId(randomUUID());
  const stepId = formatStepId(randomUUID());
  const toolCallId = formatToolCallId(randomUUID());
  const approvalId = formatApprovalId(randomUUID());
  const path = join(root, `000001-${sessionId}.jsonl`);
  try {
    const sink = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    await sink.append(header(DurableRecordTypes.ConversationCreated, conversationId, sessionId));
    await sink.append(header(DurableRecordTypes.SessionCreated, conversationId, sessionId));
    await sink.append(
      header(DurableRecordTypes.TurnStarted, conversationId, sessionId, { turnId, payload: { input: "run" } }),
    );
    await sink.append(
      header(DurableRecordTypes.UserInputAccepted, conversationId, sessionId, { turnId, payload: { text: "run" } }),
    );
    await sink.append(
      header(DurableRecordTypes.ProviderStepStarted, conversationId, sessionId, { turnId, stepId, payload: {} }),
    );
    await sink.append(
      header(DurableRecordTypes.ToolRequested, conversationId, sessionId, {
        turnId,
        stepId,
        toolCallId,
        payload: { name: "shell", input: { command: "pwd" }, providerOrder: 0, requiresApproval: true },
      }),
    );
    await sink.append(
      header(DurableRecordTypes.ApprovalRequested, conversationId, sessionId, {
        turnId,
        toolCallId,
        approvalId,
        payload: { reason: "run shell" },
      }),
    );

    const reopened = await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    assert.deepEqual(
      reopened
        .records()
        .slice(-3)
        .map((record) => record.type),
      [DurableRecordTypes.ToolResultAborted, DurableRecordTypes.ProviderStepFailed, DurableRecordTypes.TurnAborted],
    );
    assert.equal(reopened.records().at(-3).payload.synthetic, true);
    assert.equal(reopened.records().at(-3).payload.error.code, "SERVER_RESTARTED");
    assert.equal(reopened.records().at(-1).payload.reason, "SERVER_RESTARTED");
    assert.deepEqual(reduceEngineState(reopened.records()).issues, []);
    assert.deepEqual(reduceProviderHistory(reopened.records()).issues, []);
    const repairedBytes = await readFile(path, "utf8");
    await JsonlSessionDurableSink.open({ path, conversationId, sessionId });
    assert.equal(await readFile(path, "utf8"), repairedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function command(type, scope, payload) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: formatCommandId(randomUUID()),
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...scope,
    payload,
  };
}

function header(type, conversationId, sessionId, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: formatRecordId(randomUUID()),
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId,
    sessionId,
    payload: {},
    ...extra,
  };
}
