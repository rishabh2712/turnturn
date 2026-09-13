import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@turnturn/protocol";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutorPort,
  ToolInputValidation,
  ToolOutcome,
} from "./ports.js";
import { editTool, readTool, writeTool } from "./workspace/file-tools.js";
import { discoverAgentsMd, resolveFileMentions } from "./workspace/instructions.js";
import { WorkspacePathGuard } from "./workspace/path-guard.js";
import { globTool, grepTool } from "./workspace/search-tools.js";
import { shellTool } from "./workspace/shell-tool.js";
import { validateWorkspaceToolInput, workspaceToolDefinitions } from "./workspace/tool-definitions.js";
import { failed, ToolInputError } from "./workspace/tool-results.js";

export interface WorkspaceToolExecutorOptions {
  readonly roots: readonly string[];
  readonly defaultRoot?: string;
  readonly maxOutputBytes?: number;
  readonly shellTimeoutMs?: number;
}

export { workspaceToolDefinitions };
export { WorkspacePathGuard } from "./workspace/path-guard.js";

export function createWorkspaceToolExecutor(options: WorkspaceToolExecutorOptions): ToolExecutorPort {
  return new WorkspaceToolExecutor(options);
}

class WorkspaceToolExecutor implements ToolExecutorPort {
  private readonly paths: WorkspacePathGuard;
  private readonly maxOutputBytes: number;
  private readonly shellTimeoutMs: number;

  constructor(private readonly options: WorkspaceToolExecutorOptions) {
    this.paths = new WorkspacePathGuard(options);
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.shellTimeoutMs = options.shellTimeoutMs ?? 30_000;
  }

  definitions(): readonly ToolDefinition[] {
    return workspaceToolDefinitions;
  }

  validate(request: { readonly name: string; readonly input: JsonValue }): ToolInputValidation {
    return validateWorkspaceToolInput(request.name, request.input);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolOutcome> {
    try {
      switch (request.name) {
        case "read":
          return await readTool(request.input, this.paths);
        case "write":
          return await writeTool(request.input, this.paths);
        case "edit":
          return await editTool(request.input, this.paths);
        case "glob":
          return await globTool(request.input, this.paths);
        case "grep":
          return await grepTool(request.input, this.paths);
        case "shell":
          return await shellTool(request, this.paths, {
            maxOutputBytes: this.maxOutputBytes,
            shellTimeoutMs: this.shellTimeoutMs,
            ...(this.options.defaultRoot === undefined ? {} : { defaultRoot: this.options.defaultRoot }),
          });
        default:
          return failed("UNKNOWN_TOOL", `Unknown tool: ${request.name}`);
      }
    } catch (error) {
      if (error instanceof ToolInputError) return failed(error.code, error.message);
      return failed("TOOL_UNHANDLED", error instanceof Error ? error.message : String(error), true);
    }
  }
}

export { discoverAgentsMd, resolveFileMentions };

export function tempRootPrefix(): string {
  return path.join(os.tmpdir(), "turnturn-tools-");
}
