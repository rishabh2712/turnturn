// @vitest-environment happy-dom
//
// D18 regression — tool output must never go through the Markdown pipeline,
// even when it looks like Markdown or HTML. A file read, shell stdout, and a
// search match containing Markdown/HTML-shaped text must render as literal
// text inside `<pre>`/plain nodes, not as interpreted elements.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ToolActionCard } from "../src/components/tool/ToolActionCard";

afterEach(cleanup);

test("shell stdout containing Markdown/HTML-looking content stays literal text in <pre>", () => {
  const { container } = render(
    <ToolActionCard
      action={{
        key: "action:tool_1",
        toolCallId: "tool_1",
        name: "shell",
        displayName: "Run command",
        headline: "Running a command",
        kind: "shell",
        status: "completed",
        detail: {
          presentation: "shell",
          command: "cat notes.md",
          cwd: "/workspace",
          exitCode: 0,
          stdout: "# Heading\n\n<script>window.__pwned = true</script>\n**bold**",
          truncated: false,
        },
        synthetic: false,
        progress: [],
      }}
    />,
  );
  const pres = Array.from(container.querySelectorAll("pre"));
  const stdoutPre = pres.find((pre) => pre.textContent?.includes("Heading"));
  expect(stdoutPre).toBeDefined();
  expect(stdoutPre?.querySelector("script")).toBeNull();
  expect(stdoutPre?.querySelector("h1")).toBeNull();
  expect(stdoutPre?.querySelector("strong")).toBeNull();
  expect(stdoutPre?.textContent).toContain("# Heading");
  expect(stdoutPre?.textContent).toContain("<script>window.__pwned = true</script>");
  expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
});

test("a file-read tool result containing Markdown-looking content stays literal text", () => {
  const { container } = render(
    <ToolActionCard
      action={{
        key: "action:tool_2",
        toolCallId: "tool_2",
        name: "read",
        displayName: "Read file",
        headline: "Read README.md",
        kind: "read",
        status: "completed",
        detail: {
          presentation: "file-read",
          path: "README.md",
          startLine: 1,
          lineCount: 2,
          content: "# Not a real heading\n[a link](javascript:alert(1))",
        },
        synthetic: false,
        progress: [],
      }}
    />,
  );
  const pre = container.querySelector("pre");
  expect(pre).not.toBeNull();
  expect(pre?.querySelector("h1")).toBeNull();
  expect(pre?.querySelector("a")).toBeNull();
  expect(pre?.textContent).toContain("# Not a real heading");
});
