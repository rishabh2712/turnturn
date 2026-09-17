export const ContextContributionKinds = {
  SystemInstructions: "system-instructions",
  DeveloperInstructions: "developer-instructions",
  ConversationHistory: "conversation-history",
  ToolDefinitions: "tool-definitions",
  ToolInteractions: "tool-interactions",
  WorkspaceInstructions: "workspace-instructions",
  Compaction: "compaction",
  Memory: "memory",
} as const;

export type BuiltInContextContributionKind = (typeof ContextContributionKinds)[keyof typeof ContextContributionKinds];
