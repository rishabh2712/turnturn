import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@turnturn/protocol";
import type { ToolExecutionRequest, ToolExecutorPort, ToolOutcome } from "./ports.js";

export interface WorkspaceToolExecutorOptions {
  readonly roots: readonly string[];
  readonly defaultRoot?: string;
  readonly maxOutputBytes?: number;
  readonly shellTimeoutMs?: number;
}

interface ConfinedPath {
  readonly root: string;
  readonly absolute: string;
  readonly relative: string;
}

interface ToolDefinition {
  readonly mutating: boolean;
}

export const workspaceToolDefinitions = {
  read: { mutating: false },
  write: { mutating: true },
  edit: { mutating: true },
  glob: { mutating: false },
  grep: { mutating: false },
  shell: { mutating: true },
} as const satisfies Record<string, ToolDefinition>;

export function createWorkspaceToolExecutor(options: WorkspaceToolExecutorOptions): ToolExecutorPort {
  return new WorkspaceToolExecutor(options);
}

class WorkspaceToolExecutor implements ToolExecutorPort {
  private readonly rootsPromise: Promise<readonly string[]>;
  private readonly maxOutputBytes: number;
  private readonly shellTimeoutMs: number;

  constructor(private readonly options: WorkspaceToolExecutorOptions) {
    this.rootsPromise = normalizeRoots(options.roots);
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.shellTimeoutMs = options.shellTimeoutMs ?? 30_000;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolOutcome> {
    try {
      switch (request.name) {
        case "read":
          return await this.read(request.input);
        case "write":
          return await this.write(request.input);
        case "edit":
          return await this.edit(request.input);
        case "glob":
          return await this.glob(request.input);
        case "grep":
          return await this.grep(request.input);
        case "shell":
          return await this.shell(request);
        default:
          return failed("UNKNOWN_TOOL", `Unknown tool: ${request.name}`);
      }
    } catch (error) {
      if (error instanceof ToolInputError) return failed(error.code, error.message);
      return failed("TOOL_UNHANDLED", error instanceof Error ? error.message : String(error), true);
    }
  }

  private async read(input: JsonValue): Promise<ToolOutcome> {
    const args = objectInput(input);
    const target = await this.confineExistingFile(stringField(args, "path"));
    const bytes = await fs.readFile(target.absolute);
    const text = utf8Text(bytes);
    if (!text.ok) return failed("BINARY_FILE", "File is binary or not valid UTF-8");

    const lines = text.value.split(/\r?\n/);
    const offset = optionalInteger(args.offset, 1);
    const limit = optionalInteger(args.limit, lines.length);
    const start = Math.max(1, offset);
    const selected = lines.slice(start - 1, start - 1 + Math.max(0, limit));
    return completed({
      path: target.relative,
      content: selected.map((line, index) => `${start + index}: ${line}`).join("\n"),
      startLine: start,
      lineCount: selected.length,
    });
  }

  private async write(input: JsonValue): Promise<ToolOutcome> {
    const args = objectInput(input);
    const target = await this.confineForWrite(stringField(args, "path"));
    const content = stringField(args, "content");
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, content, "utf8");
    return completed({ path: target.relative, bytesWritten: Buffer.byteLength(content, "utf8") });
  }

  private async edit(input: JsonValue): Promise<ToolOutcome> {
    const args = objectInput(input);
    const target = await this.confineExistingFile(stringField(args, "path"));
    const oldText = stringField(args, "oldText");
    const newText = stringField(args, "newText");
    const replaceAll = booleanField(args, "replaceAll", false);
    const before = await fs.readFile(target.absolute);
    const decoded = utf8Text(before);
    if (!decoded.ok) return failed("BINARY_FILE", "File is binary or not valid UTF-8");

    const matches = countOccurrences(decoded.value, oldText);
    if (matches === 0) return failed("EDIT_NOT_FOUND", "Exact edit text was not found");
    if (matches > 1 && !replaceAll) return failed("EDIT_MULTIPLE_MATCHES", "Exact edit text matched more than once");

    const after = replaceAll ? decoded.value.split(oldText).join(newText) : decoded.value.replace(oldText, newText);
    await fs.writeFile(target.absolute, after, "utf8");
    return completed({
      path: target.relative,
      replacements: replaceAll ? matches : 1,
      bytesWritten: Buffer.byteLength(after),
    });
  }

  private async glob(input: JsonValue): Promise<ToolOutcome> {
    const args = objectInput(input);
    const base = await this.confineExistingDirectory(optionalString(args.path) ?? ".");
    const pattern = optionalString(args.pattern) ?? "**/*";
    const limit = optionalInteger(args.limit, 100);
    const entries = await walkFiles(base.absolute);
    const matches = entries
      .map((entry) => ({ ...entry, relative: toPosix(path.relative(base.root, entry.absolute)) }))
      .filter((entry) => globMatches(toPosix(path.relative(base.absolute, entry.absolute)), pattern))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.relative);
    return completed({ matches, truncated: entries.length > matches.length && matches.length >= limit });
  }

  private async grep(input: JsonValue): Promise<ToolOutcome> {
    const args = objectInput(input);
    const base = await this.confineExistingDirectory(optionalString(args.path) ?? ".");
    const query = stringField(args, "query");
    const caseSensitive = booleanField(args, "caseSensitive", true);
    const limit = optionalInteger(args.limit, 100);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: JsonValue[] = [];
    for (const entry of await walkFiles(base.absolute)) {
      if (matches.length >= limit) break;
      const bytes = await fs.readFile(entry.absolute);
      const decoded = utf8Text(bytes);
      if (!decoded.ok) continue;
      const lines = decoded.value.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (haystack.includes(needle)) {
          matches.push({ path: toPosix(path.relative(base.root, entry.absolute)), lineNumber: index + 1, line });
          if (matches.length >= limit) break;
        }
      }
    }
    return completed({ matches, truncated: matches.length >= limit });
  }

  private async shell(request: ToolExecutionRequest): Promise<ToolOutcome> {
    const args = objectInput(request.input);
    const command = stringField(args, "command");
    const cwd = await this.confineExistingDirectory(optionalString(args.cwd) ?? this.options.defaultRoot ?? ".");
    const timeoutMs = optionalInteger(args.timeoutMs, this.shellTimeoutMs);
    return await runShell(command, cwd.absolute, timeoutMs, this.maxOutputBytes, request);
  }

  private async confineExistingFile(value: string): Promise<ConfinedPath> {
    const confined = await this.confineExisting(value);
    const stats = await fs.stat(confined.absolute);
    if (!stats.isFile()) throw toolError("NOT_FILE", "Path is not a file");
    return confined;
  }

  private async confineExistingDirectory(value: string): Promise<ConfinedPath> {
    const confined = await this.confineExisting(value);
    const stats = await fs.stat(confined.absolute);
    if (!stats.isDirectory()) throw toolError("NOT_DIRECTORY", "Path is not a directory");
    return confined;
  }

  private async confineExisting(value: string): Promise<ConfinedPath> {
    const candidate = path.resolve(await this.defaultRoot(), value);
    const real = await fs.realpath(candidate);
    return await this.confineReal(real);
  }

  private async confineForWrite(value: string): Promise<ConfinedPath> {
    const candidate = path.resolve(await this.defaultRoot(), value);
    const ancestor = await nearestExistingAncestor(path.dirname(candidate));
    const confinedAncestor = await this.confineReal(await fs.realpath(ancestor));
    const relativeFromAncestor = path.relative(ancestor, candidate);
    const absolute = path.join(confinedAncestor.absolute, relativeFromAncestor);
    return { root: confinedAncestor.root, absolute, relative: toPosix(path.relative(confinedAncestor.root, absolute)) };
  }

  private async confineReal(real: string): Promise<ConfinedPath> {
    for (const root of await this.rootsPromise) {
      if (isInside(root, real)) {
        return { root, absolute: real, relative: toPosix(path.relative(root, real)) || "." };
      }
    }
    throw toolError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the configured workspace roots");
  }

  private async defaultRoot(): Promise<string> {
    if (this.options.defaultRoot) return path.resolve(this.options.defaultRoot);
    const [root] = await this.rootsPromise;
    if (!root) throw toolError("NO_WORKSPACE_ROOT", "No workspace root configured");
    return root;
  }
}

async function normalizeRoots(roots: readonly string[]): Promise<readonly string[]> {
  const normalized = await Promise.all(roots.map((root) => fs.realpath(path.resolve(root))));
  return [...new Set(normalized)];
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  request: ToolExecutionRequest,
): Promise<ToolOutcome> {
  return await new Promise<ToolOutcome>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const finish = (outcome: ToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    };
    const abort = () => {
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    request.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      request.callbacks.stdout(text);
      const truncated = appendTruncated(stdout, text, maxOutputBytes);
      stdout = truncated.value;
      stdoutTruncated ||= truncated.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      request.callbacks.stderr(text);
      const truncated = appendTruncated(stderr, text, maxOutputBytes);
      stderr = truncated.value;
      stderrTruncated ||= truncated.truncated;
    });
    child.on("error", (error) => {
      finish(failed("SHELL_SPAWN_FAILED", error.message));
    });
    child.on("close", (code, signal) => {
      if (request.signal.aborted) {
        finish(failed("SHELL_ABORTED", "Shell command aborted"));
        return;
      }
      if (timedOut) {
        finish(failed("SHELL_TIMEOUT", `Shell command timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        finish(completed({ stdout, stderr, exitCode: code, stdoutTruncated, stderrTruncated }));
        return;
      }
      finish(failed("SHELL_NON_ZERO_EXIT", `Shell command exited with ${code ?? `signal ${signal}`}`));
    });
  });
}

async function walkFiles(root: string): Promise<Array<{ readonly absolute: string; readonly mtimeMs: number }>> {
  const output: Array<{ readonly absolute: string; readonly mtimeMs: number }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const real = await fs.realpath(absolute);
      if (entry.isDirectory()) {
        await visit(real);
      } else if (entry.isFile()) {
        const stats = await fs.stat(real);
        output.push({ absolute: real, mtimeMs: stats.mtimeMs });
      }
    }
  }
  await visit(root);
  return output;
}

async function nearestExistingAncestor(start: string): Promise<string> {
  let cursor = start;
  while (true) {
    try {
      const stats = await fs.stat(cursor);
      if (!stats.isDirectory()) throw toolError("NOT_DIRECTORY", "Nearest existing write ancestor is not a directory");
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export async function discoverAgentsMd(root: string, target: string): Promise<readonly string[]> {
  const rootReal = await fs.realpath(path.resolve(root));
  const targetReal = await fs.realpath(path.resolve(rootReal, target));
  if (!isInside(rootReal, targetReal))
    throw toolError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the workspace root");
  const start = (await fs.stat(targetReal)).isDirectory() ? targetReal : path.dirname(targetReal);
  const dirs: string[] = [];
  let cursor = start;
  while (isInside(rootReal, cursor)) {
    dirs.push(cursor);
    if (cursor === rootReal) break;
    cursor = path.dirname(cursor);
  }
  dirs.reverse();
  const docs: string[] = [];
  for (const directory of dirs) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, constants.R_OK);
        docs.push(await fs.readFile(candidate, "utf8"));
        break;
      } catch {
        // No scoped instruction file in this directory.
      }
    }
  }
  return docs;
}

export async function resolveFileMentions(text: string, root: string): Promise<string> {
  const rootReal = await fs.realpath(path.resolve(root));
  return await replaceAsync(text, /@([\w./-]+)/g, async (match, rawPath: string) => {
    try {
      const real = await fs.realpath(path.resolve(rootReal, rawPath));
      if (!isInside(rootReal, real)) return match;
      return `@${toPosix(path.relative(rootReal, real))}`;
    } catch {
      return match;
    }
  });
}

async function replaceAsync(
  value: string,
  expression: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(match[0], ...match.slice(1))));
  let output = value;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const replacement = replacements[index];
    if (!match || replacement === undefined || match.index === undefined) continue;
    output = `${output.slice(0, match.index)}${replacement}${output.slice(match.index + match[0].length)}`;
  }
  return output;
}

function objectInput(input: JsonValue): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw toolError("INVALID_INPUT", "Tool input must be an object");
  return input as Record<string, JsonValue>;
}

function stringField(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw toolError("INVALID_INPUT", `${key} must be a string`);
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function booleanField(input: Record<string, JsonValue>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

function utf8Text(bytes: Buffer): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  if (bytes.includes(0)) return { ok: false };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { ok: true, value: text };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) throw toolError("INVALID_INPUT", "oldText must not be empty");
  let count = 0;
  let index = 0;
  while (true) {
    index = haystack.indexOf(needle, index);
    if (index === -1) break;
    count += 1;
    index += needle.length;
  }
  return count;
}

function globMatches(value: string, pattern: string): boolean {
  const expression = `^${pattern
    .split("**")
    .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
    .join(".*")}$`;
  return new RegExp(expression).test(value);
}

function appendTruncated(
  existing: string,
  next: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const combined = existing + next;
  const bytes = Buffer.byteLength(combined);
  if (bytes <= maxBytes) return { value: combined, truncated: false };
  return { value: combined.slice(0, maxBytes), truncated: true };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function completed(output: JsonValue): ToolOutcome {
  return { kind: "completed", output };
}

function failed(code: string, message: string, fatal = false): ToolOutcome {
  return { kind: "failed", error: { code, message, retryable: false, fatal } };
}

function toolError(code: string, message: string): Error {
  return new ToolInputError(code, message);
}

export function tempRootPrefix(): string {
  return path.join(os.tmpdir(), "turnturn-tools-");
}

class ToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
