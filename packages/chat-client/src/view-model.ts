import type {
  ApprovalDecisions,
  ApprovalId,
  CancellationMetadata,
  ConversationId,
  JsonValue,
  RecordId,
  SerializedError,
  SessionId,
  StepId,
  ToolCallId,
  TurnId,
} from "@turnturn/protocol";

export type OrderKey = readonly [sessionOrdinal: number, anchorSequence: number, tiebreak: number];

export interface ItemBase {
  readonly key: string;
  readonly sessionId: SessionId;
  readonly order: OrderKey;
}

export interface UserMessageItem extends ItemBase {
  readonly kind: "user-message";
  readonly turnId: TurnId;
  readonly text: string;
  readonly source: "durable" | "optimistic";
}

export interface AssistantMessageItem extends ItemBase {
  readonly kind: "assistant-message";
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly text: string;
  readonly source: "durable" | "live";
  readonly streaming: boolean;
}

export type ToolCallStatus =
  | "requested"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "aborted";

export type ToolGroupStatus = Exclude<ToolCallStatus, "requested"> | "partial-failure";

export interface ApprovalView {
  readonly approvalId: ApprovalId;
  readonly reason: string;
  readonly status: "pending" | "allowed" | "denied" | "cancelled";
  readonly decision?: ApprovalDecisions;
}

export interface SearchMatchView {
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
}

export type ToolCallDetail =
  | {
      readonly presentation: "file-read";
      readonly path?: string;
      readonly content?: string;
      readonly startLine?: number;
      readonly lineCount?: number;
    }
  | { readonly presentation: "file-write"; readonly path?: string; readonly bytesWritten?: number }
  | {
      readonly presentation: "file-edit";
      readonly path?: string;
      readonly oldText?: string;
      readonly newText?: string;
      readonly replacements?: number;
    }
  | {
      readonly presentation: "search";
      readonly query?: string;
      readonly matches: readonly SearchMatchView[];
      readonly truncated: boolean;
    }
  | {
      readonly presentation: "paths";
      readonly pattern?: string;
      readonly paths: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly presentation: "shell";
      readonly command: string;
      readonly cwd?: string;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
      readonly truncated: boolean;
    }
  | { readonly presentation: "json"; readonly value: JsonValue };

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
  readonly status: ToolCallStatus;
  readonly headline: string;
  readonly detail: ToolCallDetail;
  readonly requiresApproval: boolean;
  readonly approval?: ApprovalView;
  readonly error?: SerializedError;
  readonly cancellation?: CancellationMetadata;
  readonly synthetic: boolean;
  readonly durationMs?: number;
  readonly progress: readonly string[];
  readonly streamedOutput?: string;
}

export interface ToolActivityGroupItem extends ItemBase {
  readonly kind: "tool-activity";
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly summary: string;
  readonly status: ToolGroupStatus;
  readonly calls: readonly ToolCallView[];
}

export interface ApprovalRequestItem extends ItemBase {
  readonly kind: "approval-request";
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly toolCallId: ToolCallId;
  readonly approvalId: ApprovalId;
  readonly reason: string;
  readonly tool: ToolCallView;
}

export interface TurnStatusItem extends ItemBase {
  readonly kind: "turn-status";
  readonly turnId: TurnId;
  readonly status: "completed" | "failed" | "aborted";
  readonly stopReason?: string;
  readonly reason?: string;
  readonly error?: SerializedError;
}

export interface SessionBoundaryItem extends ItemBase {
  readonly kind: "session-boundary";
  readonly provider?: string;
  readonly model?: string;
  readonly message: string;
}

export type ConversationViewItem =
  | UserMessageItem
  | AssistantMessageItem
  | ToolActivityGroupItem
  | ApprovalRequestItem
  | TurnStatusItem
  | SessionBoundaryItem;

export type TurnPhase =
  | "idle"
  | "waiting-for-model"
  | "generating"
  | "awaiting-approval"
  | "executing-tools"
  | "finishing";

export interface ProjectionIssue {
  readonly code: string;
  readonly message: string;
  readonly sessionId?: SessionId;
  readonly recordId?: RecordId;
  readonly turnId?: TurnId;
}

export interface ConversationView {
  readonly conversationId: ConversationId;
  readonly items: readonly ConversationViewItem[];
  readonly activeTurn?: { readonly turnId: TurnId; readonly phase: TurnPhase; readonly canStop: boolean };
  readonly pendingApproval?: ApprovalRequestItem;
  readonly diagnostics: readonly ProjectionIssue[];
}
