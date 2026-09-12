import type { DurableSink } from "@turnturn/assistant-core/ports";
import {
  type ConversationId,
  type DurableRecord,
  type DurableRecordDraft,
  DurableRecordTypes,
  formatRecordId,
  SCHEMA_VERSION,
  type SerializedError,
  type SessionId,
} from "@turnturn/protocol";
import { reduceEngineState, StepStatuses, ToolStatuses, TurnStatuses } from "@turnturn/protocol/engine-state";
import { JsonlSessionLogWriter, readSessionLog, SessionLogIssueCodes } from "@turnturn/protocol/session-log";

export interface OpenSessionSinkOptions {
  readonly path: string;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
}

export class JsonlSessionDurableSink implements DurableSink {
  private readonly storedRecords: DurableRecord[];
  private appendChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly writer: JsonlSessionLogWriter,
    private readonly scope: OpenSessionSinkOptions,
    records: readonly DurableRecord[],
  ) {
    this.storedRecords = [...records];
  }

  static async open(options: OpenSessionSinkOptions): Promise<JsonlSessionDurableSink> {
    const existing = await readSessionLog(options.path, { allowMissing: true });
    for (const record of existing.records) {
      if (record.conversationId !== options.conversationId || record.sessionId !== options.sessionId) {
        throw new Error(`Session log identity mismatch: ${options.path}`);
      }
    }
    if (
      existing.recoveredCorruptTail &&
      existing.issues.every((issue) => issue.code === SessionLogIssueCodes.InvalidJson)
    ) {
      await recoverTornTail(options.path, existing.records.length);
    }
    const writer = await JsonlSessionLogWriter.open(options.path);
    const sink = new JsonlSessionDurableSink(writer, options, existing.records);
    await sink.repairInterruptedTurn();
    return sink;
  }

  records(): readonly DurableRecord[] {
    return this.storedRecords;
  }

  async append(draft: DurableRecordDraft): Promise<DurableRecord> {
    if (draft.conversationId !== this.scope.conversationId || draft.sessionId !== this.scope.sessionId) {
      throw new Error(`Record does not belong to session ${this.scope.sessionId}`);
    }
    let stored!: DurableRecord;
    this.appendChain = this.appendChain.then(async () => {
      const result = await this.writer.append(draft);
      stored = result.record;
      if (result.appended) this.storedRecords.push(stored);
    });
    await this.appendChain;
    return stored;
  }

  private async repairInterruptedTurn(): Promise<void> {
    const state = reduceEngineState(this.storedRecords);
    if (state.issues.length > 0) throw new Error(`Cannot repair invalid session log: ${this.scope.path}`);
    const error: SerializedError = {
      code: "SERVER_RESTARTED",
      message: "Server restarted before the turn completed",
      retryable: true,
      fatal: false,
    };
    for (const turn of state.turns.values()) {
      if (turn.status !== TurnStatuses.Running) continue;
      for (const tool of state.tools.values()) {
        if (tool.turnId !== turn.turnId || terminalTool(tool.status)) continue;
        await this.append({
          ...repairBase(DurableRecordTypes.ToolResultAborted, turn.conversationId, turn.sessionId),
          turnId: turn.turnId,
          toolCallId: tool.toolCallId,
          payload: { error, synthetic: true },
        });
      }
      for (const step of state.steps.values()) {
        if (step.turnId !== turn.turnId || step.status !== StepStatuses.Running) continue;
        await this.append({
          ...repairBase(DurableRecordTypes.ProviderStepFailed, turn.conversationId, turn.sessionId),
          turnId: turn.turnId,
          stepId: step.stepId,
          payload: { error },
        });
      }
      await this.append({
        ...repairBase(DurableRecordTypes.TurnAborted, turn.conversationId, turn.sessionId),
        turnId: turn.turnId,
        payload: { reason: "SERVER_RESTARTED" },
      });
    }
  }
}

function repairBase<T extends DurableRecordTypes>(type: T, conversationId: ConversationId, sessionId: SessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: formatRecordId(randomUUID()),
    type,
    createdAt: new Date().toISOString(),
    conversationId,
    sessionId,
  } as const;
}

function terminalTool(status: ToolStatuses): boolean {
  return [ToolStatuses.Completed, ToolStatuses.Failed, ToolStatuses.Denied, ToolStatuses.Aborted].includes(status);
}

async function recoverTornTail(path: string, validRecords: number): Promise<void> {
  const original = await readFile(path, "utf8");
  const backup = `${path}.corrupt-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  await copyFile(path, backup);
  const validPrefix = original.split("\n").slice(0, validRecords).join("\n");
  const temp = `${path}.repair-${randomUUID()}`;
  await writeFile(temp, validPrefix.length === 0 ? "" : `${validPrefix}\n`);
  await rename(temp, path);
}

import { randomUUID } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
