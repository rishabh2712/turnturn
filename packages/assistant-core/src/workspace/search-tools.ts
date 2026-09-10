import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@turnturn/protocol";
import type { ToolOutcome } from "../ports.js";
import { utf8Text } from "./file-tools.js";
import { toPosix, type WorkspacePathGuard } from "./path-guard.js";
import { booleanField, objectInput, optionalInteger, optionalString, stringField } from "./tool-input.js";
import { completed } from "./tool-results.js";

export async function globTool(input: JsonValue, paths: WorkspacePathGuard): Promise<ToolOutcome> {
  const args = objectInput(input);
  const base = await paths.existingDirectory(optionalString(args.path) ?? ".");
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

export async function grepTool(input: JsonValue, paths: WorkspacePathGuard): Promise<ToolOutcome> {
  const args = objectInput(input);
  const base = await paths.existingDirectory(optionalString(args.path) ?? ".");
  const query = stringField(args, "query");
  const caseSensitive = booleanField(args, "caseSensitive", true);
  const limit = optionalInteger(args.limit, 100);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const matches: JsonValue[] = [];
  for (const entry of await walkFiles(base.absolute)) {
    if (matches.length >= limit) break;
    const decoded = utf8Text(await fs.readFile(entry.absolute));
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

function globMatches(value: string, pattern: string): boolean {
  const expression = `^${pattern
    .split("**")
    .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
    .join(".*")}$`;
  return new RegExp(expression).test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
