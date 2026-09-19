import type { ConversationId, SessionId, StepId, TurnId } from "@turnturn/protocol";
import type {
  ApprovalRequestItem,
  AssistantMessageItem,
  ProjectionIssue,
  SessionBoundaryItem,
  ToolCallDetail,
  ToolCallStatus,
  TurnPhase,
  TurnStatusItem,
  UserMessageItem,
} from "./view-model.js";

export type ToolActionKind = "read" | "write" | "edit" | "search" | "paths" | "shell" | "unknown";

export type CommandPurpose =
  | { readonly kind: "repository-search"; readonly label: string }
  | { readonly kind: "test-run"; readonly label: string }
  | { readonly kind: "repository-status"; readonly label: string }
  | { readonly kind: "file-list"; readonly label: string };

export interface ToolActionPresentation {
  readonly key: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly displayName: string;
  readonly headline: string;
  readonly kind: ToolActionKind;
  readonly status: ToolCallStatus;
  readonly detail: ToolCallDetail;
  readonly commandPurpose?: CommandPurpose;
  readonly approval?: ApprovalRequestItem;
  readonly durationMs?: number;
  readonly synthetic: boolean;
  readonly progress: readonly string[];
  readonly streamedOutput?: string;
}

export interface AgentStepPresentation {
  readonly key: string;
  readonly stepId: StepId;
  readonly ordinal: number;
  readonly status: "streaming" | "using-tools" | "awaiting-approval" | "completed" | "failed";
  readonly summary: string;
  readonly assistantOutput?: AssistantMessageItem;
  readonly actions: readonly ToolActionPresentation[];
}

export interface TurnPresentation {
  readonly kind: "turn";
  readonly key: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly user: UserMessageItem;
  readonly steps: readonly AgentStepPresentation[];
  readonly finalResponse?: AssistantMessageItem;
  readonly outcome?: TurnStatusItem;
  readonly blockingApproval?: ApprovalRequestItem;
}

export type ConversationTimelineItem = SessionBoundaryItem | TurnPresentation;

export interface ConversationPresentation {
  readonly conversationId: ConversationId;
  readonly timeline: readonly ConversationTimelineItem[];
  readonly activeTurn?: { readonly turnId: TurnId; readonly phase: TurnPhase; readonly canStop: boolean };
  readonly pendingApproval?: ApprovalRequestItem;
  readonly diagnostics: readonly ProjectionIssue[];
}
