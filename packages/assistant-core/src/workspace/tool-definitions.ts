import type { JsonValue } from "@turnturn/protocol";
import { z } from "zod";
import type { ToolDefinition, ToolInputValidation } from "../ports.js";

const readSchema = z
  .object({
    path: z.string().describe("Workspace-relative path to the UTF-8 text file to read."),
    offset: z.number().int().positive().optional().describe("One-based first line to return. Omit to start at line 1."),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Maximum number of lines to return. Omit to read the file."),
  })
  .strict();

const writeSchema = z
  .object({
    path: z.string().describe("Workspace-relative path to create or overwrite."),
    content: z.string().describe("Complete UTF-8 file content to write."),
  })
  .strict();

const editSchema = z
  .object({
    path: z.string().describe("Workspace-relative path to the UTF-8 text file to edit."),
    oldText: z.string().describe("Exact text to replace. Must match the file content exactly."),
    newText: z.string().describe("Replacement text to write in place of oldText."),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Set true to replace every occurrence; default replaces one occurrence."),
  })
  .strict();

const globSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe("Workspace-relative directory to search. Omit to search from the workspace root."),
    pattern: z.string().optional().describe("Glob pattern such as src/*.ts or **/*.md. Omit to list all files."),
    limit: z.number().int().nonnegative().optional().describe("Maximum number of matching paths to return."),
  })
  .strict();

const grepSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe("Workspace-relative directory to search. Omit to search from the workspace root."),
    query: z.string().describe("Literal text to find in UTF-8 files."),
    caseSensitive: z.boolean().optional().describe("Whether matching should be case-sensitive. Defaults to true."),
    limit: z.number().int().nonnegative().optional().describe("Maximum number of matching lines to return."),
  })
  .strict();

const shellSchema = z
  .object({
    command: z.string().describe("Shell command to run in the workspace."),
    cwd: z
      .string()
      .optional()
      .describe("Workspace-relative working directory. Omit to use the default workspace root."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum runtime in milliseconds before aborting the command."),
  })
  .strict();

export type ReadToolInput = z.infer<typeof readSchema>;
export type WriteToolInput = z.infer<typeof writeSchema>;
export type EditToolInput = z.infer<typeof editSchema>;
export type GlobToolInput = z.infer<typeof globSchema>;
export type GrepToolInput = z.infer<typeof grepSchema>;
export type ShellToolInput = z.infer<typeof shellSchema>;

export interface WorkspaceToolInputByName {
  readonly read: ReadToolInput;
  readonly write: WriteToolInput;
  readonly edit: EditToolInput;
  readonly glob: GlobToolInput;
  readonly grep: GrepToolInput;
  readonly shell: ShellToolInput;
}

const workspaceToolSpecs = [
  {
    name: "read",
    description: "Read a UTF-8 text file from the workspace, optionally limited to a line range.",
    schema: readSchema,
    mutating: false,
  },
  {
    name: "write",
    description: "Create or overwrite a UTF-8 text file in the workspace.",
    schema: writeSchema,
    mutating: true,
  },
  {
    name: "edit",
    description: "Apply an exact string replacement to a UTF-8 text file in the workspace.",
    schema: editSchema,
    mutating: true,
  },
  {
    name: "glob",
    description: "Find workspace files whose paths match a glob pattern.",
    schema: globSchema,
    mutating: false,
  },
  {
    name: "grep",
    description: "Search UTF-8 workspace files for literal text and return matching lines.",
    schema: grepSchema,
    mutating: false,
  },
  {
    name: "shell",
    description: "Run a shell command in the workspace and return stdout, stderr, and exit status.",
    schema: shellSchema,
    mutating: true,
  },
] as const;

type WorkspaceToolName = (typeof workspaceToolSpecs)[number]["name"];

const schemaByName = new Map<string, z.ZodType>(workspaceToolSpecs.map((tool) => [tool.name, tool.schema] as const));

export const workspaceToolDefinitions: readonly ToolDefinition[] = workspaceToolSpecs.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: jsonSchemaFor(tool.schema),
  mutating: tool.mutating,
}));

export function validateWorkspaceToolInput(name: string, input: JsonValue): ToolInputValidation {
  const schema = schemaByName.get(name);
  if (schema === undefined) {
    return { ok: false, error: schemaError("UNKNOWN_TOOL", `Unknown tool: ${name}`) };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: schemaError("TOOL_SCHEMA_INVALID", z.prettifyError(parsed.error)) };
  }
  return { ok: true, input: parsed.data as JsonValue };
}

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return schemaByName.has(name);
}

function jsonSchemaFor(schema: z.ZodType): JsonValue {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema as JsonValue;
}

function schemaError(code: string, message: string) {
  return { code, message, retryable: false, fatal: false };
}
