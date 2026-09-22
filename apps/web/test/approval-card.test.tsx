// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  render(<ApprovalCard item={item} status="pending" onResolve={vi.fn()} />);
  expect(screen.getByText("echo '<script>alert(1)</script>'")).toBeDefined();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("Working directory: /workspace")).toBeDefined();
  expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Deny" })).toBeDefined();
});

test("a card renders the shared resolving state and disables both choices", () => {
  const onResolve = vi.fn(async () => {});
  const view = render(<ApprovalCard item={item} status="pending" onResolve={onResolve} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onResolve).toHaveBeenCalledWith(ApprovalDecisions.Allow);
  view.rerender(<ApprovalCard item={item} status="resolving" onResolve={onResolve} />);
  expect(screen.getByText("Resolving…")).toBeDefined();
  expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(true);
  expect(onResolve).toHaveBeenCalledOnce();
});

test("the controller's stale state removes choices without inventing a decision", () => {
  render(<ApprovalCard item={item} status="stale" onResolve={vi.fn()} />);
  expect(screen.getByText(/This approval is no longer pending/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
});
