import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableRecordTypes as Durable,
  formatApprovalId,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { JsonlSessionLogWriter } from "@turnturn/protocol/session-log";

export { Durable };

export async function sessionFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "turnturn-chat-projector-"));
  const writer = await JsonlSessionLogWriter.open(join(root, "session.jsonl"));
  const conversationId = options.conversationId ?? formatConversationId(randomUUID());
  const sessionId = formatSessionId(randomUUID());
  const turnId = formatTurnId(randomUUID());
  const stepId = formatStepId(randomUUID());
  const records = [];
  t.after(async () => {
    assert.deepEqual(reduceEngineState(records).issues, []);
    await rm(root, { recursive: true, force: true });
  });

  async function add(type, payload = {}, scope = {}) {
    const draft = {
      schemaVersion: SCHEMA_VERSION,
      recordId: formatRecordId(randomUUID()),
      type,
      createdAt: new Date(Date.UTC(2026, 8, 14) + records.length * 10).toISOString(),
      conversationId,
      sessionId,
      ...scope,
      payload,
    };
    const { record } = await writer.append(draft);
    records.push(record);
    return record;
  }

  await add(Durable.ConversationCreated, {});
  await add(Durable.SessionCreated, options.provider === undefined ? {} : { provider: options.provider });

  function event(type, payload, scope = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: formatEventId(randomUUID()),
      type,
      createdAt: new Date(Date.UTC(2026, 8, 14) + records.length * 10).toISOString(),
      conversationId,
      sessionId,
      ...scope,
      payload,
    };
  }

  function slice(overrides = {}) {
    return {
      conversationId,
      sessionId,
      ordinal: options.ordinal ?? 0,
      records: [...records],
      lastSequence: records.at(-1)?.sequence ?? 0,
      hasGap: false,
      live: [],
      diagnostics: [],
      ...overrides,
    };
  }

  async function startTurn(input = "Investigate this") {
    await add(Durable.TurnStarted, { input }, { turnId });
    await add(Durable.UserInputAccepted, { text: input }, { turnId });
  }

  async function startStep(id = stepId) {
    await add(Durable.ProviderStepStarted, {}, { turnId, stepId: id });
  }

  return {
    conversationId,
    sessionId,
    turnId,
    stepId,
    records,
    add,
    event,
    slice,
    startTurn,
    startStep,
    anotherStepId: () => formatStepId(randomUUID()),
    toolCallId: () => formatToolCallId(randomUUID()),
    approvalId: () => formatApprovalId(randomUUID()),
  };
}
