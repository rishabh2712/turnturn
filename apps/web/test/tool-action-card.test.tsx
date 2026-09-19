// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ToolActionCard } from "../src/components/tool/ToolActionCard";

afterEach(cleanup);

test("a shell action leads with human meaning and preserves the exact command", () => {
  render(
    <ToolActionCard
      action={{
        key: "action:tool_1",
        toolCallId: "tool_1",
        name: "shell",
        displayName: "Run command",
        headline: "Running tests",
        kind: "shell",
        status: "completed",
        detail: {
          presentation: "shell",
          command: "pnpm test",
          cwd: "/workspace",
          exitCode: 0,
          stdout: "108 tests passed",
          truncated: false,
        },
        commandPurpose: { kind: "test-run", label: "Running tests" },
        synthetic: false,
        progress: [],
      }}
    />,
  );
  expect(screen.getByText("Run command")).toBeTruthy();
  expect(screen.getByText("Running tests")).toBeTruthy();
  expect(screen.getByText("pnpm test")).toBeTruthy();
  expect(screen.getByText("108 tests passed")).toBeTruthy();
});

test("an edit action renders intentional before and after panels instead of a JSON tree", () => {
  const { container } = render(
    <ToolActionCard
      action={{
        key: "action:tool_2",
        toolCallId: "tool_2",
        name: "edit",
        displayName: "Edit file",
        headline: "Edited src/session.ts",
        kind: "edit",
        status: "completed",
        detail: {
          presentation: "file-edit",
          path: "src/session.ts",
          oldText: "const oldValue = 1;",
          newText: "const newValue = 1;",
          replacements: 1,
        },
        synthetic: false,
        progress: [],
      }}
    />,
  );
  expect(screen.getByText("Before")).toBeTruthy();
  expect(screen.getByText("After")).toBeTruthy();
  expect(screen.getByText("const oldValue = 1;")).toBeTruthy();
  expect(container.textContent).not.toContain('"presentation": "file-edit"');
});
