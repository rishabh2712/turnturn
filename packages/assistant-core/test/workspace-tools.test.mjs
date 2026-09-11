import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceToolExecutor,
  discoverAgentsMd,
  resolveFileMentions,
  workspaceToolDefinitions,
} from "../dist/workspace-tools.js";

test("workspace tools confine paths after resolving dot segments and symlinks", async () => {
  const { root, outside, tools } = await workspace();
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link-out"));

  const dotdot = await execute(tools, "read", { path: "../outside/secret.txt" });
  const symlink = await execute(tools, "read", { path: "link-out" });

  assert.equal(dotdot.kind, "failed");
  assert.equal(dotdot.error.code, "PATH_OUTSIDE_WORKSPACE");
  assert.equal(symlink.kind, "failed");
  assert.equal(symlink.error.code, "PATH_OUTSIDE_WORKSPACE");
});

test("read returns line-numbered UTF-8 slices and rejects binary files", async () => {
  const { root, tools } = await workspace();
  await fs.writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree", "utf8");
  await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2]));

  const read = await execute(tools, "read", { path: "notes.txt", offset: 2, limit: 2 });
  const binary = await execute(tools, "read", { path: "blob.bin" });

  assert.deepEqual(read.output, {
    path: "notes.txt",
    content: "2: two\n3: three",
    startLine: 2,
    lineCount: 2,
  });
  assert.equal(binary.kind, "failed");
  assert.equal(binary.error.code, "BINARY_FILE");
});

test("write and exact edit update files with distinct failure codes", async () => {
  const { root, tools } = await workspace();

  const write = await execute(tools, "write", { path: "dir/file.txt", content: "alpha beta beta" });
  const missing = await execute(tools, "edit", { path: "dir/file.txt", oldText: "gamma", newText: "delta" });
  const multiple = await execute(tools, "edit", { path: "dir/file.txt", oldText: "beta", newText: "BETA" });
  const edited = await execute(tools, "edit", {
    path: "dir/file.txt",
    oldText: "beta",
    newText: "BETA",
    replaceAll: true,
  });

  assert.equal(write.kind, "completed");
  assert.equal(missing.error.code, "EDIT_NOT_FOUND");
  assert.equal(multiple.error.code, "EDIT_MULTIPLE_MATCHES");
  assert.deepEqual(edited.output, { path: "dir/file.txt", replacements: 2, bytesWritten: 15 });
  assert.equal(await fs.readFile(path.join(root, "dir/file.txt"), "utf8"), "alpha BETA BETA");
});

test("glob and grep return structured capped results", async () => {
  const { root, tools } = await workspace();
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/a.txt"), "needle\nx", "utf8");
  await fs.writeFile(path.join(root, "src/b.log"), "nope", "utf8");

  const glob = await execute(tools, "glob", { path: ".", pattern: "src/*.txt", limit: 10 });
  const grep = await execute(tools, "grep", { path: ".", query: "needle", limit: 10 });

  assert.deepEqual(glob.output.matches, ["src/a.txt"]);
  assert.deepEqual(grep.output.matches, [{ path: "src/a.txt", lineNumber: 1, line: "needle" }]);
});

test("shell streams output, reports non-zero exits and timeouts distinctly", async () => {
  const { tools } = await workspace();
  const streamed = [];

  const ok = await execute(tools, "shell", { command: "printf hi" }, { stdout: (text) => streamed.push(text) });
  const nonZero = await execute(tools, "shell", { command: "exit 7" });
  const timeout = await execute(tools, "shell", { command: 'node -e "setTimeout(() => {}, 1000)"', timeoutMs: 10 });

  assert.equal(ok.kind, "completed");
  assert.equal(ok.output.stdout, "hi");
  assert.deepEqual(streamed, ["hi"]);
  assert.equal(nonZero.kind, "failed");
  assert.equal(nonZero.error.code, "SHELL_NON_ZERO_EXIT");
  assert.equal(timeout.kind, "failed");
  assert.equal(timeout.error.code, "SHELL_TIMEOUT");
});

test("shell aborts through AbortSignal and flags deterministic truncation", async () => {
  const { tools } = await workspace({ maxOutputBytes: 3 });
  const controller = new AbortController();
  const aborting = tools.execute({
    ...toolRequest("shell", { command: 'node -e "setTimeout(() => {}, 1000)"' }),
    signal: controller.signal,
  });
  controller.abort();

  const aborted = await aborting;
  const truncated = await execute(tools, "shell", { command: "printf abcdef" });

  assert.equal(aborted.kind, "failed");
  assert.equal(aborted.error.code, "SHELL_ABORTED");
  assert.deepEqual(truncated.output, {
    stdout: "abc",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: true,
    stderrTruncated: false,
  });
});

test("tool metadata marks only write edit and shell as mutating", () => {
  assert.deepEqual(
    Object.fromEntries(workspaceToolDefinitions.map((definition) => [definition.name, definition.mutating])),
    {
      read: false,
      write: true,
      edit: true,
      glob: false,
      grep: false,
      shell: true,
    },
  );
});

test("tool definitions carry prompt descriptions and object schemas", () => {
  assert.deepEqual(
    workspaceToolDefinitions.map((definition) => definition.name),
    ["read", "write", "edit", "glob", "grep", "shell"],
  );

  for (const definition of workspaceToolDefinitions) {
    assert.equal(typeof definition.description, "string");
    assert.notEqual(definition.description.trim(), "");
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.$schema, undefined);
    assert.ok(Object.keys(definition.parameters.properties).length > 0);
  }
});

test("workspace tool executor validates raw inputs against declared schemas", async () => {
  const { tools } = await workspace();

  const invalid = tools.validate({ name: "read", input: { offset: 1 } });
  const valid = tools.validate({ name: "read", input: { path: "notes.txt", offset: 1 } });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "TOOL_SCHEMA_INVALID");
  assert.equal(valid.ok, true);
});

test("AGENTS.md discovery is broad-to-specific and mentions preserve unresolved paths", async () => {
  const { root } = await workspace();
  await fs.writeFile(path.join(root, "AGENTS.md"), "root");
  await fs.mkdir(path.join(root, "a/b"), { recursive: true });
  await fs.writeFile(path.join(root, "a", "AGENTS.md"), "a");
  await fs.writeFile(path.join(root, "a/b", "file.txt"), "hello");

  const docs = await discoverAgentsMd(root, "a/b/file.txt");
  const mentions = await resolveFileMentions("see @a/b/file.txt and @missing.txt", root);

  assert.deepEqual(docs, ["root", "a"]);
  assert.equal(mentions, "see @a/b/file.txt and @missing.txt");
});

test("edit lands verifiably on disk in a real git repository", async () => {
  const { root, tools } = await workspace();
  await execFile("git", ["init"], root);
  await execute(tools, "write", { path: "tracked.txt", content: "before\n" });
  await execFile("git", ["add", "tracked.txt"], root);
  await execFile("git", ["commit", "-m", "seed"], root, {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });

  await execute(tools, "edit", { path: "tracked.txt", oldText: "before", newText: "after" });
  const diff = await execFile("git", ["diff", "--", "tracked.txt"], root);

  assert.match(diff.stdout, /-before/);
  assert.match(diff.stdout, /\+after/);
  assert.equal(await fs.readFile(path.join(root, "tracked.txt"), "utf8"), "after\n");
});

async function workspace(options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "turnturn-tools-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  return {
    root,
    outside,
    tools: createWorkspaceToolExecutor({ roots: [root], defaultRoot: root, shellTimeoutMs: 500, ...options }),
  };
}

async function execute(tools, name, input, callbacks = {}) {
  return await tools.execute(toolRequest(name, input, callbacks));
}

function toolRequest(name, input, callbacks = {}) {
  return {
    conversationId: "conv_018f1f4e-8d5f-7abc-8123-000000000001",
    sessionId: "sess_018f1f4e-8d5f-7abc-8123-000000000002",
    turnId: "turn_018f1f4e-8d5f-7abc-8123-000000000003",
    toolCallId: "tool_018f1f4e-8d5f-7abc-8123-000000000004",
    name,
    input,
    signal: new AbortController().signal,
    callbacks: {
      stdout: () => {},
      stderr: () => {},
      progress: () => {},
      ...callbacks,
    },
  };
}

async function execFile(command, args, cwd, env = {}) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr}`));
    });
  });
}
