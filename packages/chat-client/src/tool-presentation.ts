import type { ToolActionKind, ToolActionPresentation } from "./presentation-model.js";
import type { ApprovalRequestItem, ToolCallView } from "./view-model.js";

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  grep: "Search repository",
  glob: "Find files",
  shell: "Run command",
};

export function presentToolCall(call: ToolCallView, approval?: ApprovalRequestItem): ToolActionPresentation {
  const commandPurpose = call.detail.presentation === "shell" ? interpretShellCommand(call.detail.command) : undefined;
  return {
    key: `action:${call.toolCallId}`,
    toolCallId: call.toolCallId,
    name: call.name,
    displayName: DISPLAY_NAMES[call.name] ?? humanize(call.name),
    headline: commandPurpose?.label ?? call.headline,
    kind: actionKind(call),
    status: call.status,
    detail: call.detail,
    ...(commandPurpose === undefined ? {} : { commandPurpose }),
    ...(approval === undefined ? {} : { approval }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    synthetic: call.synthetic,
    progress: call.progress,
    ...(call.streamedOutput === undefined ? {} : { streamedOutput: call.streamedOutput }),
  };
}

/** Conservative and display-only. Ambiguous shell syntax deliberately returns undefined. */
export function interpretShellCommand(command: string) {
  const tokens = safeTokens(command);
  if (tokens === undefined || tokens.length === 0) return undefined;
  const executable = basename(tokens[0] ?? "");
  if (executable === "rg" || executable === "grep") {
    return { kind: "repository-search" as const, label: "Searching the repository" };
  }
  if (
    executable === "jest" ||
    executable === "vitest" ||
    executable === "pytest" ||
    (executable === "go" && tokens[1] === "test") ||
    (executable === "cargo" && tokens[1] === "test") ||
    ((executable === "pnpm" || executable === "npm" || executable === "yarn") && tokens.includes("test"))
  ) {
    return { kind: "test-run" as const, label: "Running tests" };
  }
  if (executable === "git" && tokens[1] === "status") {
    return { kind: "repository-status" as const, label: "Checking repository status" };
  }
  if (executable === "ls" || executable === "find") {
    return { kind: "file-list" as const, label: "Exploring files" };
  }
  return undefined;
}

function safeTokens(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[;&|><`\n\r]/.test(trimmed) || trimmed.includes("$(")) return undefined;
  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g);
  if (tokens === null) return undefined;
  return tokens.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function actionKind(call: ToolCallView): ToolActionKind {
  switch (call.detail.presentation) {
    case "file-read":
      return "read";
    case "file-write":
      return "write";
    case "file-edit":
      return "edit";
    case "search":
      return "search";
    case "paths":
      return "paths";
    case "shell":
      return "shell";
    case "json":
      return "unknown";
  }
}

function humanize(value: string): string {
  const text = value.replace(/[-_]+/g, " ").trim();
  return text.length === 0 ? "Tool action" : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
