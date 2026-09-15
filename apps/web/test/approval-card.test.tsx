// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequestItem } from "@turnturn/chat-client";
import { ApprovalDecisions } from "@turnturn/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ApprovalCard } from "../src/components/approval/ApprovalCard";

afterEach(cleanup);

const item = {
  kind: "approval-request",
  reason: "Run a command",
  tool: {
    name: "shell",
    input: { command: "echo '<script>alert(1)</script>'", cwd: "/workspace" },
    detail: { presentation: "shell", command: "echo '<script>alert(1)</script>'", cwd: "/workspace", truncated: false },
  },
} as ApprovalRequestItem;

test("approval shows the exact shell command as text, working directory, and both choices", () => {
  render(<ApprovalCard item={item} onResolve={vi.fn()} />);
  expect(screen.getByText("echo '<script>alert(1)</script>'")).toBeDefined();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("Working directory: /workspace")).toBeDefined();
  expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Deny" })).toBeDefined();
});

test("an approval choice is sent once and cannot be changed while resolving", async () => {
  let release: (value: "accepted") => void = () => {};
  const onResolve = vi.fn(
    () =>
      new Promise<"accepted">((resolve) => {
        release = resolve;
      }),
  );
  render(<ApprovalCard item={item} onResolve={onResolve} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(await screen.findByText("Resolving…")).toBeDefined();
  expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(true);
  expect(onResolve).toHaveBeenCalledOnce();
  expect(onResolve).toHaveBeenCalledWith(ApprovalDecisions.Allow);
  release("accepted");
});

test("a stale approval becomes cancelled instead of a generic error", async () => {
  render(<ApprovalCard item={item} onResolve={vi.fn(async () => "cancelled" as const)} />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(screen.getByText("This approval is no longer pending.")).toBeDefined());
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
});
