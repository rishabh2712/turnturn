import type { JsonValue } from "@turnturn/protocol";
import type { SearchMatchView, ToolCallDetail, ToolCallView } from "./view-model.js";

const SUMMARY_CAP = 90;
const ELLIPSIS = "…";

interface VerbNoun {
  readonly verb: string;
  readonly noun: string;
}

const VERB_NOUNS: Readonly<Record<string, VerbNoun>> = {
  read: { verb: "Read", noun: "files" },
  write: { verb: "Wrote", noun: "files" },
  edit: { verb: "Edited", noun: "files" },
  grep: { verb: "Searched", noun: "times" },
  glob: { verb: "Found files", noun: "times" },
  shell: { verb: "Ran", noun: "commands" },
};

export function toolHeadline(name: string, input: JsonValue, output: JsonValue | undefined): string {
  switch (name) {
    case "read":
      return readHeadline(input, output);
    case "write":
      return writeHeadline(input, output);
    case "edit":
      return editHeadline(input, output);
    case "glob":
      return globHeadline(input, output);
    case "grep":
      return grepHeadline(input, output);
    case "shell":
      return shellHeadline(input, output);
    default:
      return name;
  }
}

export function toolDetail(name: string, input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  switch (name) {
    case "read":
      return readDetail(input, output);
    case "write":
      return writeDetail(input, output);
    case "edit":
      return editDetail(input, output);
    case "glob":
      return globDetail(input, output);
    case "grep":
      return grepDetail(input, output);
    case "shell":
      return shellDetail(input, output);
    default:
      return { presentation: "json", value: output ?? input };
  }
}

/**
 * Deterministic group summary: bucket calls by tool name, render each bucket as
 * "<verb> <count> <noun>" above one call and as the single call's own headline
 * otherwise, join with ", ", sentence-case, cap at 90 characters, then append
 * status adornments that are never truncated away.
 */
export function summarizeGroup(calls: readonly ToolCallView[]): string {
  if (calls.length === 0) return "";
  const buckets = new Map<string, ToolCallView[]>();
  for (const call of calls) {
    const bucket = buckets.get(call.name) ?? [];
    bucket.push(call);
    buckets.set(call.name, bucket);
  }

  const parts: string[] = [];
  for (const [name, bucket] of buckets) {
    const [first] = bucket;
    if (first === undefined) continue;
    const { verb, noun } = verbNounFor(name);
    parts.push(bucket.length > 1 ? `${verb} ${bucket.length} ${noun}` : first.headline);
  }

  const body = capAndEllipsize(sentenceCase(parts.join(", ")), SUMMARY_CAP);
  const adornments: string[] = [];
  if (calls.some((call) => call.status === "awaiting-approval")) adornments.push("needs approval");
  const failedCount = calls.filter(
    (call) => call.status === "failed" || call.status === "denied" || call.status === "aborted",
  ).length;
  if (failedCount > 0) adornments.push(`${failedCount} failed`);
  return adornments.length === 0 ? body : `${body} (${adornments.join(", ")})`;
}

function verbNounFor(name: string): VerbNoun {
  return VERB_NOUNS[name] ?? { verb: sentenceCase(name), noun: "times" };
}

function sentenceCase(value: string): string {
  if (value.length === 0) return value;
  const [head, ...rest] = value;
  return `${(head ?? "").toUpperCase()}${rest.join("")}`;
}

function capAndEllipsize(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

// --- read ---------------------------------------------------------------

function readHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(asRecord(input)?.path);
  const lineCount = asNumber(out?.lineCount);
  if (path === undefined) return "Read a file";
  if (lineCount === undefined) return `Read ${path}`;
  return `Read ${path} (${lineCount} ${plural(lineCount, "line")})`;
}

function readDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(inRec?.path);
  const content = asString(out?.content);
  const startLine = asNumber(out?.startLine);
  const lineCount = asNumber(out?.lineCount);
  return {
    presentation: "file-read",
    ...(path === undefined ? {} : { path }),
    ...(content === undefined ? {} : { content }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(lineCount === undefined ? {} : { lineCount }),
  };
}

// --- write ----------------------------------------------------------------

function writeHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(asRecord(input)?.path);
  const bytesWritten = asNumber(out?.bytesWritten);
  if (path === undefined) return "Wrote a file";
  if (bytesWritten === undefined) return `Wrote ${path}`;
  return `Wrote ${path} (${bytesWritten} ${plural(bytesWritten, "byte")})`;
}

function writeDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(inRec?.path);
  const bytesWritten = asNumber(out?.bytesWritten);
  return {
    presentation: "file-write",
    ...(path === undefined ? {} : { path }),
    ...(bytesWritten === undefined ? {} : { bytesWritten }),
  };
}

// --- edit -------------------------------------------------------------

function editHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(asRecord(input)?.path);
  const replacements = asNumber(out?.replacements);
  if (path === undefined) return "Edited a file";
  if (replacements === undefined) return `Edited ${path}`;
  return `Edited ${path} (${replacements} ${plural(replacements, "replacement")})`;
}

function editDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const path = asString(out?.path) ?? asString(inRec?.path);
  const oldText = asString(inRec?.oldText);
  const newText = asString(inRec?.newText);
  const replacements = asNumber(out?.replacements);
  return {
    presentation: "file-edit",
    ...(path === undefined ? {} : { path }),
    ...(oldText === undefined ? {} : { oldText }),
    ...(newText === undefined ? {} : { newText }),
    ...(replacements === undefined ? {} : { replacements }),
  };
}

// --- glob ---------------------------------------------------------------

function globHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const out = asRecord(output);
  const matches = asArray(out?.matches);
  const pattern = asString(asRecord(input)?.pattern);
  if (matches === undefined) return pattern === undefined ? "Found files" : `Found files matching "${pattern}"`;
  const suffix = pattern === undefined ? "" : ` matching "${pattern}"`;
  return `Found ${matches.length} ${plural(matches.length, "file")}${suffix}`;
}

function globDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const pattern = asString(inRec?.pattern);
  const paths = asArray(out?.matches)?.filter((value): value is string => typeof value === "string") ?? [];
  const truncated = asBoolean(out?.truncated) ?? false;
  return {
    presentation: "paths",
    ...(pattern === undefined ? {} : { pattern }),
    paths,
    truncated,
  };
}

// --- grep -----------------------------------------------------------------

function grepHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const out = asRecord(output);
  const query = asString(asRecord(input)?.query);
  const matches = asSearchMatches(out?.matches);
  if (matches === undefined) return query === undefined ? "Searched" : `Searched for "${query}"`;
  const fileCount = new Set(matches.map((match) => match.path)).size;
  const suffix = ` in ${fileCount} ${plural(fileCount, "file")}`;
  return query === undefined ? `Searched${suffix}` : `Searched for "${query}"${suffix}`;
}

function grepDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const query = asString(inRec?.query);
  const matches = asSearchMatches(out?.matches) ?? [];
  const truncated = asBoolean(out?.truncated) ?? false;
  return {
    presentation: "search",
    ...(query === undefined ? {} : { query }),
    matches,
    truncated,
  };
}

// --- shell ------------------------------------------------------------

function shellHeadline(input: JsonValue, output: JsonValue | undefined): string {
  const command = asString(asRecord(input)?.command);
  const out = asRecord(output);
  const exitCode = asNumber(out?.exitCode);
  const base = command === undefined ? "Ran a command" : `Ran ${command}`;
  return exitCode === undefined || exitCode === 0 ? base : `${base} (exit ${exitCode})`;
}

function shellDetail(input: JsonValue, output: JsonValue | undefined): ToolCallDetail {
  const inRec = asRecord(input);
  const out = asRecord(output);
  const command = asString(inRec?.command) ?? "";
  const cwd = asString(inRec?.cwd);
  const stdout = asString(out?.stdout);
  const stderr = asString(out?.stderr);
  const exitCode = asNumber(out?.exitCode);
  const truncated = (asBoolean(out?.stdoutTruncated) ?? false) || (asBoolean(out?.stderrTruncated) ?? false);
  return {
    presentation: "shell",
    command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(exitCode === undefined ? {} : { exitCode }),
    truncated,
  };
}

// --- JsonValue accessors --------------------------------------------------

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, JsonValue>;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asSearchMatches(value: JsonValue | undefined): SearchMatchView[] | undefined {
  const array = asArray(value);
  if (array === undefined) return undefined;
  const matches: SearchMatchView[] = [];
  for (const entry of array) {
    const record = asRecord(entry);
    const path = asString(record?.path);
    const lineNumber = asNumber(record?.lineNumber);
    const line = asString(record?.line);
    if (path === undefined || lineNumber === undefined || line === undefined) continue;
    matches.push({ path, lineNumber, line });
  }
  return matches;
}
