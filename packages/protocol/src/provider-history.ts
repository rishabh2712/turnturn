import {
  DurableRecordTypes,
  type DurableRecord,
  type JsonValue,
  type RecordId,
  type SerializedError,
  type StepId,
  type ToolCallId,
  type TurnId
} from "./index.js";

export enum ProviderHistoryItemTypes {
  UserInput = "user.input",
  AssistantMessage = "assistant.message",
  ToolRequest = "tool.request",
  ToolResult = "tool.result"
}
export type ProviderHistoryItemType = ProviderHistoryItemTypes;

export enum ProviderToolResultStatuses {
  Completed = "completed",
  Failed = "failed",
  Denied = "denied",
  Aborted = "aborted"
}
export type ProviderToolResultStatus = ProviderToolResultStatuses;

export enum ProviderHistoryIssueCodes {
  DuplicateToolResult = "duplicate_tool_result",
  MissingToolRequest = "missing_tool_request",
  OutOfOrder = "out_of_order"
}
export type ProviderHistoryIssueCode = ProviderHistoryIssueCodes;

export interface ProviderHistoryIssue {
  readonly recordId: RecordId;
  readonly sequence: number;
  readonly code: ProviderHistoryIssueCode;
  readonly message: string;
}

interface ProviderHistoryItemBase {
  readonly type: ProviderHistoryItemType;
  readonly recordId: RecordId;
  readonly sequence: number;
  readonly turnId: TurnId;
}

export interface ProviderHistoryUserInput extends ProviderHistoryItemBase {
  readonly type: ProviderHistoryItemTypes.UserInput;
  readonly content: string;
}

export interface ProviderHistoryAssistantMessage extends ProviderHistoryItemBase {
  readonly type: ProviderHistoryItemTypes.AssistantMessage;
  readonly content: string;
}

export interface ProviderHistoryToolRequest extends ProviderHistoryItemBase {
  readonly type: ProviderHistoryItemTypes.ToolRequest;
  readonly stepId: StepId;
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
  readonly providerOrder: number;
  readonly requiresApproval: boolean;
  readonly providerToolCallId?: string;
}

export interface ProviderHistoryToolResult extends ProviderHistoryItemBase {
  readonly type: ProviderHistoryItemTypes.ToolResult;
  readonly toolCallId: ToolCallId;
  readonly status: ProviderToolResultStatus;
  readonly output?: JsonValue;
  readonly error?: SerializedError;
  readonly synthetic: boolean;
}

export type ProviderHistoryItem =
  | ProviderHistoryUserInput
  | ProviderHistoryAssistantMessage
  | ProviderHistoryToolRequest
  | ProviderHistoryToolResult;

export interface ProviderHistory {
  readonly items: readonly ProviderHistoryItem[];
  readonly issues: readonly ProviderHistoryIssue[];
  readonly lastSequence: number;
}

export function reduceProviderHistory(records: readonly DurableRecord[]): ProviderHistory {
  const state: MutableProviderHistory = {
    items: [],
    issues: [],
    requestedTools: new Set(),
    terminalTools: new Set(),
    lastSequence: 0
  };

  for (const record of records) applyRecord(state, record);

  return {
    items: state.items,
    issues: state.issues,
    lastSequence: state.lastSequence
  };
}

interface MutableProviderHistory {
  readonly items: ProviderHistoryItem[];
  readonly issues: ProviderHistoryIssue[];
  readonly requestedTools: Set<ToolCallId>;
  readonly terminalTools: Set<ToolCallId>;
  lastSequence: number;
}

function applyRecord(state: MutableProviderHistory, record: DurableRecord): void {
  if (record.sequence !== state.lastSequence + 1) {
    issue(state, record, ProviderHistoryIssueCodes.OutOfOrder, `Expected sequence ${state.lastSequence + 1}, got ${record.sequence}`);
  }
  state.lastSequence = Math.max(state.lastSequence, record.sequence);

  switch (record.type) {
    case DurableRecordTypes.UserInputAccepted:
      state.items.push({
        type: ProviderHistoryItemTypes.UserInput,
        recordId: record.recordId,
        sequence: record.sequence,
        turnId: record.turnId,
        content: record.payload.text
      });
      return;
    case DurableRecordTypes.AssistantMessageCompleted:
      state.items.push({
        type: ProviderHistoryItemTypes.AssistantMessage,
        recordId: record.recordId,
        sequence: record.sequence,
        turnId: record.turnId,
        content: record.payload.content
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
        ...optional({ providerToolCallId: record.payload.providerToolCallId })
      });
      return;
    case DurableRecordTypes.ToolResultCompleted:
      addToolResult(state, record, ProviderToolResultStatuses.Completed, optional({ output: record.payload.output }), record.payload.synthetic ?? false);
      return;
    case DurableRecordTypes.ToolResultFailed:
      addToolResult(state, record, ProviderToolResultStatuses.Failed, { error: record.payload.error }, record.payload.synthetic ?? false);
      return;
    case DurableRecordTypes.ToolResultDenied:
      addToolResult(state, record, ProviderToolResultStatuses.Denied, { error: record.payload.error }, record.payload.synthetic ?? false);
      return;
    case DurableRecordTypes.ToolResultAborted:
      addToolResult(state, record, ProviderToolResultStatuses.Aborted, { error: record.payload.error }, record.payload.synthetic ?? false);
      return;
    default:
      return;
  }
}

function addToolResult(
  state: MutableProviderHistory,
  record: DurableRecord<
    DurableRecordTypes.ToolResultCompleted |
    DurableRecordTypes.ToolResultFailed |
    DurableRecordTypes.ToolResultDenied |
    DurableRecordTypes.ToolResultAborted
  >,
  status: ProviderToolResultStatus,
  details: Pick<ProviderHistoryToolResult, "output"> | Pick<ProviderHistoryToolResult, "error">,
  synthetic: boolean
): void {
  if (!state.requestedTools.has(record.toolCallId)) {
    issue(state, record, ProviderHistoryIssueCodes.MissingToolRequest, `Tool result references missing tool request: ${record.toolCallId}`);
  }
  if (state.terminalTools.has(record.toolCallId)) {
    issue(state, record, ProviderHistoryIssueCodes.DuplicateToolResult, `Tool result already exists: ${record.toolCallId}`);
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
    ...details
  });
}

function issue(state: MutableProviderHistory, record: DurableRecord, code: ProviderHistoryIssueCode, message: string): void {
  state.issues.push({ recordId: record.recordId, sequence: record.sequence, code, message });
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
