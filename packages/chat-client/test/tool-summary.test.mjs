import assert from "node:assert/strict";
import test from "node:test";
import { summarizeGroup, toolDetail, toolHeadline } from "../dist/tool-summary.js";

function call(overrides = {}) {
  return {
    toolCallId: "tool_x",
    name: "read",
    input: {},
    status: "completed",
    headline: "",
    detail: { presentation: "json", value: null },
    requiresApproval: false,
    synthetic: false,
    progress: [],
    ...overrides,
  };
}

// --- headline, table-driven: one row per tool per status -----------------

const headlineCases = [
  {
    name: "read pending (no output)",
    tool: "read",
    input: { path: "src/a.ts" },
    output: undefined,
    expected: "Read src/a.ts",
  },
  {
    name: "read completed",
    tool: "read",
    input: { path: "src/a.ts" },
    output: { path: "src/a.ts", content: "x", startLine: 1, lineCount: 1 },
    expected: "Read src/a.ts (1 line)",
  },
  {
    name: "read completed, multiple lines",
    tool: "read",
    input: { path: "src/a.ts" },
    output: { path: "src/a.ts", content: "a\nb", startLine: 1, lineCount: 2 },
    expected: "Read src/a.ts (2 lines)",
  },
  {
    name: "write pending",
    tool: "write",
    input: { path: "src/b.ts", content: "x" },
    output: undefined,
    expected: "Wrote src/b.ts",
  },
  {
    name: "write completed",
    tool: "write",
    input: { path: "src/b.ts", content: "x" },
    output: { path: "src/b.ts", bytesWritten: 42 },
    expected: "Wrote src/b.ts (42 bytes)",
  },
  {
    name: "edit completed, single replacement",
    tool: "edit",
    input: { path: "src/c.ts", oldText: "a", newText: "b" },
    output: { path: "src/c.ts", replacements: 1, bytesWritten: 3 },
    expected: "Edited src/c.ts (1 replacement)",
  },
  {
    name: "edit completed, multiple replacements",
    tool: "edit",
    input: { path: "src/c.ts", oldText: "a", newText: "b", replaceAll: true },
    output: { path: "src/c.ts", replacements: 3, bytesWritten: 9 },
    expected: "Edited src/c.ts (3 replacements)",
  },
  {
    name: "glob completed with pattern",
    tool: "glob",
    input: { pattern: "src/*.ts" },
    output: { matches: ["a.ts", "b.ts"], truncated: false },
    expected: 'Found 2 files matching "src/*.ts"',
  },
  {
    name: "glob completed, no matches",
    tool: "glob",
    input: {},
    output: { matches: [], truncated: false },
    expected: "Found 0 files",
  },
  {
    name: "grep completed",
    tool: "grep",
    input: { query: "TODO" },
    output: {
      matches: [
        { path: "a.ts", lineNumber: 1, line: "// TODO" },
        { path: "b.ts", lineNumber: 2, line: "// TODO" },
      ],
      truncated: false,
    },
    expected: 'Searched for "TODO" in 2 files',
  },
  {
    name: "grep pending",
    tool: "grep",
    input: { query: "TODO" },
    output: undefined,
    expected: 'Searched for "TODO"',
  },
  {
    name: "shell completed, exit 0",
    tool: "shell",
    input: { command: "pwd" },
    output: { stdout: "/", stderr: "", exitCode: 0 },
    expected: "Ran pwd",
  },
  {
    name: "shell completed, non-zero exit",
    tool: "shell",
    input: { command: "false" },
    output: { stdout: "", stderr: "", exitCode: 1 },
    expected: "Ran false (exit 1)",
  },
  {
    name: "unknown tool falls back to its name",
    tool: "frobnicate",
    input: { anything: true },
    output: undefined,
    expected: "frobnicate",
  },
];

for (const { name, tool, input, output, expected } of headlineCases) {
  test(`headline: ${name}`, () => {
    assert.equal(toolHeadline(tool, input, output), expected);
  });
}

// --- detail, one per presentation -----------------------------------------

test("detail: file-read carries path, content, and line range", () => {
  const detail = toolDetail("read", { path: "a.ts" }, { path: "a.ts", content: "1: x", startLine: 1, lineCount: 1 });
  assert.deepEqual(detail, { presentation: "file-read", path: "a.ts", content: "1: x", startLine: 1, lineCount: 1 });
});

test("detail: file-write carries path and bytesWritten", () => {
  const detail = toolDetail("write", { path: "a.ts", content: "x" }, { path: "a.ts", bytesWritten: 1 });
  assert.deepEqual(detail, { presentation: "file-write", path: "a.ts", bytesWritten: 1 });
});

test("detail: file-edit carries the before/after text", () => {
  const detail = toolDetail(
    "edit",
    { path: "a.ts", oldText: "a", newText: "b" },
    { path: "a.ts", replacements: 1, bytesWritten: 1 },
  );
  assert.deepEqual(detail, {
    presentation: "file-edit",
    path: "a.ts",
    oldText: "a",
    newText: "b",
    replacements: 1,
  });
});

test("detail: paths carries the pattern and truncation flag", () => {
  const detail = toolDetail("glob", { pattern: "*.ts" }, { matches: ["a.ts"], truncated: true });
  assert.deepEqual(detail, { presentation: "paths", pattern: "*.ts", paths: ["a.ts"], truncated: true });
});

test("detail: search carries the query, matches, and truncation flag", () => {
  const detail = toolDetail(
    "grep",
    { query: "x" },
    { matches: [{ path: "a.ts", lineNumber: 1, line: "x" }], truncated: false },
  );
  assert.deepEqual(detail, {
    presentation: "search",
    query: "x",
    matches: [{ path: "a.ts", lineNumber: 1, line: "x" }],
    truncated: false,
  });
});

test("detail: shell carries command, cwd, output, and exit code", () => {
  const detail = toolDetail(
    "shell",
    { command: "pwd", cwd: "sub" },
    { stdout: "/", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false },
  );
  assert.deepEqual(detail, {
    presentation: "shell",
    command: "pwd",
    cwd: "sub",
    stdout: "/",
    stderr: "",
    exitCode: 0,
    truncated: false,
  });
});

test("detail: shell reports truncation when either stream was cut", () => {
  const detail = toolDetail(
    "shell",
    { command: "yes" },
    { stdout: "y", stderr: "", exitCode: 0, stdoutTruncated: true, stderrTruncated: false },
  );
  assert.equal(detail.truncated, true);
});

test("detail: an unknown tool falls back to json", () => {
  const detail = toolDetail("frobnicate", { a: 1 }, { b: 2 });
  assert.deepEqual(detail, { presentation: "json", value: { b: 2 } });
});

test("detail: json fallback uses input when there is no output yet", () => {
  const detail = toolDetail("frobnicate", { a: 1 }, undefined);
  assert.deepEqual(detail, { presentation: "json", value: { a: 1 } });
});

// --- group summary ---------------------------------------------------------

test("summary: a single call uses its own headline", () => {
  const summary = summarizeGroup([call({ name: "read", headline: "Read a.ts (3 lines)" })]);
  assert.equal(summary, "Read a.ts (3 lines)");
});

test("summary: multiple calls of the same tool collapse to a count", () => {
  const summary = summarizeGroup([
    call({ toolCallId: "1", name: "read", headline: "Read a.ts (1 line)" }),
    call({ toolCallId: "2", name: "read", headline: "Read b.ts (1 line)" }),
  ]);
  assert.equal(summary, "Read 2 files");
});

test("summary: buckets from different tools join in encounter order", () => {
  const summary = summarizeGroup([
    call({ toolCallId: "1", name: "grep", headline: 'Searched for "x" in 1 file' }),
    call({ toolCallId: "2", name: "read", headline: "Read a.ts (1 line)" }),
  ]);
  assert.equal(summary, 'Searched for "x" in 1 file, Read a.ts (1 line)');
});

test("summary: caps at 90 characters and ellipsizes without dropping adornments", () => {
  const longPath = "a".repeat(120);
  const summary = summarizeGroup([call({ name: "read", headline: `Read ${longPath} (1 line)`, status: "failed" })]);
  const withoutAdornment = summary.replace(" (1 failed)", "");
  assert.equal(withoutAdornment.length, 90);
  assert.ok(withoutAdornment.endsWith("…"));
  assert.ok(summary.endsWith(" (1 failed)"));
});

test("summary: an awaiting-approval call is adorned as needing approval", () => {
  const summary = summarizeGroup([call({ name: "shell", headline: "Ran pwd", status: "awaiting-approval" })]);
  assert.equal(summary, "Ran pwd (needs approval)");
});

test("summary: failed, denied, and aborted calls all count toward the failed adornment", () => {
  const summary = summarizeGroup([
    call({ toolCallId: "1", name: "read", headline: "Read a.ts (1 line)", status: "failed" }),
    call({ toolCallId: "2", name: "read", headline: "Read b.ts (1 line)", status: "denied" }),
    call({ toolCallId: "3", name: "read", headline: "Read c.ts (1 line)", status: "aborted" }),
  ]);
  assert.equal(summary, "Read 3 files (3 failed)");
});

test("summary: a non-zero shell exit is not a failure adornment", () => {
  const summary = summarizeGroup([call({ name: "shell", headline: "Ran false (exit 1)", status: "completed" })]);
  assert.equal(summary, "Ran false (exit 1)");
});

test("summary: an unknown tool name is sentence-cased for its bucket verb", () => {
  const summary = summarizeGroup([
    call({ toolCallId: "1", name: "frobnicate", headline: "frobnicate" }),
    call({ toolCallId: "2", name: "frobnicate", headline: "frobnicate" }),
  ]);
  assert.equal(summary, "Frobnicate 2 times");
});
