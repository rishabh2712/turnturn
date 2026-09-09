import {
  ApprovalDecisions,
  DurableRecordTypes,
  type ApprovalId,
  type ConversationId,
  type DurableRecord,
  type RecordId,
  type SerializedError,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId
} from "./index.js";

export enum TurnStatuses {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Aborted = "aborted"
}
export type TurnStatus = TurnStatuses;

export enum StepStatuses {
  Running = "running",
  Completed = "completed",
  Failed = "failed"
}
export type StepStatus = StepStatuses;

export enum ToolStatuses {
  Requested = "requested",
  AwaitingApproval = "awaiting_approval",
  Approved = "approved",
  Completed = "completed",
  Failed = "failed",
  Denied = "denied",
  Aborted = "aborted"
}
export type ToolStatus = ToolStatuses;

export enum ApprovalStatuses {
  Pending = "pending",
  Allowed = "allowed",
  Denied = "denied"
}
export type ApprovalStatus = ApprovalStatuses;

export enum EngineStateIssueCodes {
  DuplicateEntity = "duplicate_entity",
  MissingParent = "missing_parent",
  InvalidTransition = "invalid_transition",
  OutOfOrder = "out_of_order",
  UnhandledRecord = "unhandled_record"
}
export type EngineStateIssueCode = EngineStateIssueCodes;

export interface EngineStateIssue {
  readonly recordId: RecordId;
  readonly sequence: number;
  readonly code: EngineStateIssueCode;
  readonly message: string;
}

export interface ConversationState {
  readonly conversationId: ConversationId;
  readonly title?: string;
  readonly createdRecordId: RecordId;
}

export interface SessionState {
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly provider?: string;
  readonly createdRecordId: RecordId;
}

export interface TurnState {
  readonly turnId: TurnId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly status: TurnStatus;
  readonly input: string;
  readonly acceptedInput?: string;
  readonly assistantMessages: readonly string[];
  readonly stopReason?: string;
  readonly error?: SerializedError;
  readonly abortReason?: string;
  readonly startedRecordId: RecordId;
  readonly terminalRecordId?: RecordId;
}

export interface ProviderStepState {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly status: StepStatus;
  readonly provider?: string;
  readonly stopReason?: string;
  readonly error?: SerializedError;
  readonly startedRecordId: RecordId;
  readonly terminalRecordId?: RecordId;
}

export interface ToolCallState {
  readonly toolCallId: ToolCallId;
  readonly turnId: TurnId;
  readonly stepId?: StepId;
  readonly status: ToolStatus;
  readonly name?: string;
  readonly providerOrder?: number;
  readonly requiresApproval?: boolean;
  readonly providerToolCallId?: string;
  readonly requestedRecordId: RecordId;
  readonly approvalId?: ApprovalId;
  readonly terminalRecordId?: RecordId;
}

export interface ApprovalState {
  readonly approvalId: ApprovalId;
  readonly toolCallId: ToolCallId;
  readonly turnId: TurnId;
  readonly status: ApprovalStatus;
  readonly reason: string;
  readonly requestedRecordId: RecordId;
  readonly resolvedRecordId?: RecordId;
  readonly resolutionReason?: string;
}

export interface EngineState {
  readonly conversations: ReadonlyMap<ConversationId, ConversationState>;
  readonly sessions: ReadonlyMap<SessionId, SessionState>;
  readonly turns: ReadonlyMap<TurnId, TurnState>;
  readonly steps: ReadonlyMap<StepId, ProviderStepState>;
  readonly tools: ReadonlyMap<ToolCallId, ToolCallState>;
  readonly approvals: ReadonlyMap<ApprovalId, ApprovalState>;
  readonly lastSequence: number;
  readonly issues: readonly EngineStateIssue[];
}

export function reduceEngineState(records: readonly DurableRecord[]): EngineState {
  const mutable: MutableEngineState = {
    conversations: new Map(),
    sessions: new Map(),
    turns: new Map(),
    steps: new Map(),
    tools: new Map(),
    approvals: new Map(),
    lastSequence: 0,
    issues: []
  };

  for (const record of records) applyRecord(mutable, record);

  return mutable;
}

interface MutableEngineState {
  readonly conversations: Map<ConversationId, ConversationState>;
  readonly sessions: Map<SessionId, SessionState>;
  readonly turns: Map<TurnId, TurnState>;
  readonly steps: Map<StepId, ProviderStepState>;
  readonly tools: Map<ToolCallId, ToolCallState>;
  readonly approvals: Map<ApprovalId, ApprovalState>;
  lastSequence: number;
  readonly issues: EngineStateIssue[];
}

function applyRecord(state: MutableEngineState, record: DurableRecord): void {
  if (record.sequence !== state.lastSequence + 1) {
    issue(state, record, EngineStateIssueCodes.OutOfOrder, `Expected sequence ${state.lastSequence + 1}, got ${record.sequence}`);
  }
  state.lastSequence = Math.max(state.lastSequence, record.sequence);

  switch (record.type) {
    case DurableRecordTypes.ConversationCreated:
      addConversation(state, record);
      return;
    case DurableRecordTypes.SessionCreated:
      addSession(state, record);
      return;
    case DurableRecordTypes.TurnStarted:
      addTurn(state, record);
      return;
    case DurableRecordTypes.UserInputAccepted:
      updateTurn(state, record, turn => ({ ...turn, acceptedInput: record.payload.text }));
      return;
    case DurableRecordTypes.AssistantMessageCompleted:
      updateTurn(state, record, turn => ({ ...turn, assistantMessages: [...turn.assistantMessages, record.payload.content] }));
      return;
    case DurableRecordTypes.ProviderStepStarted:
      addStep(state, record);
      return;
    case DurableRecordTypes.ProviderStepCompleted:
      updateStepTerminal(state, record, StepStatuses.Completed, optional({ stopReason: record.payload.stopReason }));
      return;
    case DurableRecordTypes.ProviderStepFailed:
      updateStepTerminal(state, record, StepStatuses.Failed, { error: record.payload.error });
      return;
    case DurableRecordTypes.ToolRequested:
      addTool(state, record);
      return;
    case DurableRecordTypes.ApprovalRequested:
      addApproval(state, record);
      return;
    case DurableRecordTypes.ApprovalResolved:
      resolveApproval(state, record);
      return;
    case DurableRecordTypes.ToolResultCompleted:
      updateToolTerminal(state, record, ToolStatuses.Completed);
      return;
    case DurableRecordTypes.ToolResultFailed:
      updateToolTerminal(state, record, ToolStatuses.Failed);
      return;
    case DurableRecordTypes.ToolResultDenied:
      updateToolTerminal(state, record, ToolStatuses.Denied);
      return;
    case DurableRecordTypes.ToolResultAborted:
      updateToolTerminal(state, record, ToolStatuses.Aborted);
      return;
    case DurableRecordTypes.TurnCompleted:
      updateTurnTerminal(state, record, TurnStatuses.Completed, optional({ stopReason: record.payload.stopReason }));
      return;
    case DurableRecordTypes.TurnFailed:
      updateTurnTerminal(state, record, TurnStatuses.Failed, { error: record.payload.error });
      return;
    case DurableRecordTypes.TurnAborted:
      updateTurnTerminal(state, record, TurnStatuses.Aborted, optional({ abortReason: record.payload.reason }));
      return;
  }
}

function addConversation(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.ConversationCreated>): void {
  if (state.conversations.has(record.conversationId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Conversation already exists: ${record.conversationId}`);
    return;
  }
  state.conversations.set(record.conversationId, {
    conversationId: record.conversationId,
    createdRecordId: record.recordId,
    ...optional({ title: record.payload.title })
  });
}

function addSession(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.SessionCreated>): void {
  if (!state.conversations.has(record.conversationId)) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Session references missing conversation: ${record.conversationId}`);
  }
  if (state.sessions.has(record.sessionId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Session already exists: ${record.sessionId}`);
    return;
  }
  state.sessions.set(record.sessionId, {
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    createdRecordId: record.recordId,
    ...optional({ provider: record.payload.provider })
  });
}

function addTurn(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.TurnStarted>): void {
  if (!state.sessions.has(record.sessionId)) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Turn references missing session: ${record.sessionId}`);
  }
  if (state.turns.has(record.turnId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Turn already exists: ${record.turnId}`);
    return;
  }
  state.turns.set(record.turnId, {
    turnId: record.turnId,
    conversationId: record.conversationId,
    sessionId: record.sessionId,
    status: TurnStatuses.Running,
    input: record.payload.input,
    assistantMessages: [],
    startedRecordId: record.recordId
  });
}

function addStep(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.ProviderStepStarted>): void {
  if (!state.turns.has(record.turnId)) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Step references missing turn: ${record.turnId}`);
  }
  if (state.steps.has(record.stepId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Step already exists: ${record.stepId}`);
    return;
  }
  state.steps.set(record.stepId, {
    stepId: record.stepId,
    turnId: record.turnId,
    status: StepStatuses.Running,
    startedRecordId: record.recordId,
    ...optional({ provider: record.payload.provider })
  });
}

function addTool(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.ToolRequested>): void {
  if (!state.turns.has(record.turnId)) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Tool references missing turn: ${record.turnId}`);
  }
  if (!state.steps.has(record.stepId)) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Tool references missing provider step: ${record.stepId}`);
  }
  if (state.tools.has(record.toolCallId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Tool call already exists: ${record.toolCallId}`);
    return;
  }
  state.tools.set(record.toolCallId, {
    toolCallId: record.toolCallId,
    turnId: record.turnId,
    stepId: record.stepId,
    status: record.payload.requiresApproval ? ToolStatuses.AwaitingApproval : ToolStatuses.Requested,
    name: record.payload.name,
    providerOrder: record.payload.providerOrder,
    requiresApproval: record.payload.requiresApproval,
    requestedRecordId: record.recordId,
    ...optional({ providerToolCallId: record.payload.providerToolCallId })
  });
}

function addApproval(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.ApprovalRequested>): void {
  const tool = state.tools.get(record.toolCallId);
  if (!tool) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Approval references missing tool call: ${record.toolCallId}`);
  }
  if (state.approvals.has(record.approvalId)) {
    issue(state, record, EngineStateIssueCodes.DuplicateEntity, `Approval already exists: ${record.approvalId}`);
    return;
  }
  state.approvals.set(record.approvalId, {
    approvalId: record.approvalId,
    toolCallId: record.toolCallId,
    turnId: record.turnId,
    status: ApprovalStatuses.Pending,
    reason: record.payload.reason,
    requestedRecordId: record.recordId
  });
  if (tool && !isTerminalTool(tool.status)) {
    state.tools.set(record.toolCallId, { ...tool, status: ToolStatuses.AwaitingApproval, approvalId: record.approvalId });
  }
}

function resolveApproval(state: MutableEngineState, record: DurableRecord<DurableRecordTypes.ApprovalResolved>): void {
  const approval = state.approvals.get(record.approvalId);
  if (!approval) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Approval resolution references missing approval: ${record.approvalId}`);
    return;
  }
  if (approval.status !== ApprovalStatuses.Pending) {
    issue(state, record, EngineStateIssueCodes.InvalidTransition, `Approval already resolved: ${record.approvalId}`);
    return;
  }
  state.approvals.set(record.approvalId, {
    ...approval,
    status: record.payload.decision === ApprovalDecisions.Allow ? ApprovalStatuses.Allowed : ApprovalStatuses.Denied,
    resolvedRecordId: record.recordId,
    ...optional({ resolutionReason: record.payload.reason })
  });

  const tool = state.tools.get(record.toolCallId);
  if (!tool) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Approval resolution references missing tool call: ${record.toolCallId}`);
    return;
  }
  if (isTerminalTool(tool.status)) {
    issue(state, record, EngineStateIssueCodes.InvalidTransition, `Approval resolution cannot change terminal tool: ${record.toolCallId}`);
    return;
  }
  state.tools.set(record.toolCallId, { ...tool, status: record.payload.decision === ApprovalDecisions.Allow ? ToolStatuses.Approved : ToolStatuses.Denied });
}

function updateTurn(state: MutableEngineState, record: DurableRecord, apply: (turn: TurnState) => TurnState): void {
  if (!record.turnId) return;
  const turn = state.turns.get(record.turnId);
  if (!turn) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Record references missing turn: ${record.turnId}`);
    return;
  }
  if (turn.status !== TurnStatuses.Running) {
    issue(state, record, EngineStateIssueCodes.InvalidTransition, `Cannot update terminal turn: ${record.turnId}`);
    return;
  }
  state.turns.set(record.turnId, apply(turn));
}

function updateTurnTerminal(state: MutableEngineState, record: DurableRecord, status: TurnStatus, updates: Partial<TurnState>): void {
  updateTurn(state, record, turn => ({ ...turn, ...updates, status, terminalRecordId: record.recordId }));
}

function updateStepTerminal(state: MutableEngineState, record: DurableRecord, status: StepStatus, updates: Partial<ProviderStepState>): void {
  if (!record.stepId) return;
  const step = state.steps.get(record.stepId);
  if (!step) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Step terminal record references missing step: ${record.stepId}`);
    return;
  }
  if (step.status !== StepStatuses.Running) {
    issue(state, record, EngineStateIssueCodes.InvalidTransition, `Cannot update terminal provider step: ${record.stepId}`);
    return;
  }
  state.steps.set(record.stepId, { ...step, ...updates, status, terminalRecordId: record.recordId });
}

function updateToolTerminal(state: MutableEngineState, record: DurableRecord, status: ToolStatus): void {
  if (!record.toolCallId) return;
  const tool = state.tools.get(record.toolCallId);
  if (!tool) {
    issue(state, record, EngineStateIssueCodes.MissingParent, `Tool result references missing tool call: ${record.toolCallId}`);
    return;
  }
  if (isTerminalTool(tool.status)) {
    issue(state, record, EngineStateIssueCodes.InvalidTransition, `Cannot update terminal tool call: ${record.toolCallId}`);
    return;
  }
  state.tools.set(record.toolCallId, { ...tool, status, terminalRecordId: record.recordId });
}

function isTerminalTool(status: ToolStatus): boolean {
  return status === ToolStatuses.Completed || status === ToolStatuses.Failed || status === ToolStatuses.Denied || status === ToolStatuses.Aborted;
}

function issue(state: MutableEngineState, record: DurableRecord, code: EngineStateIssueCode, message: string): void {
  state.issues.push({ recordId: record.recordId, sequence: record.sequence, code, message });
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
