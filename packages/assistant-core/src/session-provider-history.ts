import { type DurableRecord, DurableRecordTypes, type JsonValue, type SerializedError } from "@turnturn/protocol";
import {
  type ProviderHistory,
  type ProviderHistoryIssue,
  type ProviderHistoryIssueCode,
  ProviderHistoryIssueCodes,
  ProviderHistoryItemTypes,
  type ProviderToolResultStatus,
  ProviderToolResultStatuses,
} from "@turnturn/protocol/provider-history";

interface MutableProviderHistory {
  readonly items: MutableHistoryItem[];
  readonly issues: ProviderHistoryIssue[];
  readonly requestedTools: Set<string>;
  readonly terminalTools: Set<string>;
  lastSequence: number;
}

type MutableHistoryItem = ProviderHistory["items"][number];

export function reduceSessionProviderHistory(records: readonly DurableRecord[]): ProviderHistory {
  const state: MutableProviderHistory = {
    items: [],
    issues: [],
    requestedTools: new Set(),
    terminalTools: new Set(),
    lastSequence: 0,
  };

  for (const record of records) applyRecord(state, record);

  return {
    items: state.items,
    issues: state.issues,
    lastSequence: state.lastSequence,
  };
}

function applyRecord(state: MutableProviderHistory, record: DurableRecord): void {
  state.lastSequence = Math.max(state.lastSequence, record.sequence);

  switch (record.type) {
    case DurableRecordTypes.UserInputAccepted:
      state.items.push({
        type: ProviderHistoryItemTypes.UserInput,
        recordId: record.recordId,
        sequence: record.sequence,
        turnId: record.turnId,
        content: record.payload.text,
      });
      return;
    case DurableRecordTypes.AssistantMessageCompleted:
      state.items.push({
        type: ProviderHistoryItemTypes.AssistantMessage,
        recordId: record.recordId,
        sequence: record.sequence,
        turnId: record.turnId,
        content: record.payload.content,
      });
      return;
    case DurableRecordTypes.ToolRequested:
      state.requestedTools.add(record.toolCallId);
      state.items.push({
        type: ProviderHistoryItemTypes.ToolRequest,
        recordId: record.recordId,
        sequence: record.sequence,
        turnId: record.turnId,
        stepId: record.stepId,
        toolCallId: record.toolCallId,
        name: record.payload.name,
        input: record.payload.input,
        providerOrder: record.payload.providerOrder,
        requiresApproval: record.payload.requiresApproval,
        ...optional({ providerToolCallId: record.payload.providerToolCallId }),
      });
      return;
    case DurableRecordTypes.ToolResultCompleted:
      addToolResult(
        state,
        record,
        ProviderToolResultStatuses.Completed,
        optional({ output: record.payload.output }),
        record.payload.synthetic ?? false,
      );
      return;
    case DurableRecordTypes.ToolResultFailed:
      addToolResult(
        state,
        record,
        ProviderToolResultStatuses.Failed,
        { error: record.payload.error },
        record.payload.synthetic ?? false,
      );
      return;
    case DurableRecordTypes.ToolResultDenied:
      addToolResult(
        state,
        record,
        ProviderToolResultStatuses.Denied,
        { error: record.payload.error },
        record.payload.synthetic ?? false,
      );
      return;
    case DurableRecordTypes.ToolResultAborted:
      addToolResult(
        state,
        record,
        ProviderToolResultStatuses.Aborted,
        { error: record.payload.error },
        record.payload.synthetic ?? false,
      );
      return;
    default:
      return;
  }
}

function addToolResult(
  state: MutableProviderHistory,
  record: DurableRecord<
    | DurableRecordTypes.ToolResultCompleted
    | DurableRecordTypes.ToolResultFailed
    | DurableRecordTypes.ToolResultDenied
    | DurableRecordTypes.ToolResultAborted
  >,
  status: ProviderToolResultStatus,
  details: { readonly output?: JsonValue } | { readonly error: SerializedError },
  synthetic: boolean,
): void {
  if (!state.requestedTools.has(record.toolCallId)) {
    issue(
      state,
      record,
      ProviderHistoryIssueCodes.MissingToolRequest,
      `Tool result references missing tool request: ${record.toolCallId}`,
    );
  }
  if (state.terminalTools.has(record.toolCallId)) {
    issue(
      state,
      record,
      ProviderHistoryIssueCodes.DuplicateToolResult,
      `Tool result already exists: ${record.toolCallId}`,
    );
    return;
  }
  state.terminalTools.add(record.toolCallId);
  state.items.push({
    type: ProviderHistoryItemTypes.ToolResult,
    recordId: record.recordId,
    sequence: record.sequence,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    status,
    synthetic,
    ...details,
  });
}

function issue(
  state: MutableProviderHistory,
  record: DurableRecord,
  code: ProviderHistoryIssueCode,
  message: string,
): void {
  state.issues.push({ recordId: record.recordId, sequence: record.sequence, code, message });
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
