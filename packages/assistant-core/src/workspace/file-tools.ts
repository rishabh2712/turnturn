import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@turnturn/protocol";
import type { ToolOutcome } from "../ports.js";
import type { WorkspacePathGuard } from "./path-guard.js";
import { booleanField, objectInput, optionalInteger, stringField } from "./tool-input.js";
import { completed, failed, toolError } from "./tool-results.js";

export async function readTool(input: JsonValue, paths: WorkspacePathGuard): Promise<ToolOutcome> {
  const args = objectInput(input);
  const target = await paths.existingFile(stringField(args, "path"));
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

export async function writeTool(input: JsonValue, paths: WorkspacePathGuard): Promise<ToolOutcome> {
  const args = objectInput(input);
  const target = await paths.forWrite(stringField(args, "path"));
  const content = stringField(args, "content");
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.writeFile(target.absolute, content, "utf8");
  return completed({ path: target.relative, bytesWritten: Buffer.byteLength(content, "utf8") });
}

export async function editTool(input: JsonValue, paths: WorkspacePathGuard): Promise<ToolOutcome> {
  const args = objectInput(input);
  const target = await paths.existingFile(stringField(args, "path"));
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

export function utf8Text(bytes: Buffer): { readonly ok: true; readonly value: string } | { readonly ok: false } {
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
