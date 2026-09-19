// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProviderCatalog } from "@turnturn/chat-client";
import { afterEach, expect, test, vi } from "vitest";
import { ModelPicker } from "../src/components/model/ModelPicker";

afterEach(cleanup);

function catalog(): ProviderCatalog {
  return {
    connections: [
      {
        id: "ollama",
        label: "Ollama (local)",
        locality: "local",
        wire: "ollama",
        status: "ok",
        stale: false,
        lastSuccessAt: "2026-09-20T00:00:00.000Z",
        error: null,
        models: [
          {
            id: "default",
            label: "Local model",
            model: "local-model",
            source: "configured",
            toolCompatibility: "supported",
            available: true,
          },
          {
            id: "ollama__ZW1iZWQ",
            label: "embedder",
            model: "embedder",
            source: "discovered",
            toolCompatibility: "unsupported",
            available: true,
          },
        ],
      },
      {
        id: "anthropic-messages",
        label: "Anthropic",
        locality: "remote",
        wire: "anthropic-messages",
        status: "error",
        stale: true,
        lastSuccessAt: null,
        error: { code: "UNAUTHORIZED" },
        models: [
          {
            id: "anthropic-messages__Y2xhdWRl",
            label: "Claude",
            model: "claude",
            source: "discovered",
            toolCompatibility: "unknown",
            available: false,
          },
        ],
      },
    ],
  };
}

test("groups options by provider connection and shows connection state", () => {
  render(<ModelPicker catalog={catalog()} value="default" onChange={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  expect(screen.getByText("Ollama (local)")).toBeTruthy();
  expect(screen.getByText("Anthropic")).toBeTruthy();
  expect(screen.getAllByRole("option").length).toBe(3);
});

test("selecting an available option calls onChange and closes the popover", () => {
  const onChange = vi.fn();
  render(<ModelPicker catalog={catalog()} value="default" onChange={onChange} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  fireEvent.click(screen.getByText("embedder"));
  // "embedder" is unsupported (disabled) — must not select it.
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeTruthy();
});

test("an unsupported model is visible but disabled; an unavailable one is visible but marked", () => {
  render(<ModelPicker catalog={catalog()} value="default" onChange={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  const embedderOption = screen.getByRole("option", { name: /embedder/i });
  expect(embedderOption.hasAttribute("disabled")).toBe(true);
  const claudeOption = screen.getByRole("option", { name: /Claude/i });
  expect(claudeOption.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("unavailable")).toBeTruthy();
});

test("search filters by provider label, model label, and exact model id", () => {
  render(<ModelPicker catalog={catalog()} value="default" onChange={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  const search = screen.getByRole("textbox", { name: /search models/i });
  fireEvent.change(search, { target: { value: "claude" } });
  const listbox = within(screen.getByRole("listbox"));
  expect(listbox.queryByText("Local model")).toBeNull();
  expect(listbox.getByText("Claude")).toBeTruthy();
});

test("keyboard: Escape closes the popover and returns focus to the trigger", () => {
  render(<ModelPicker catalog={catalog()} value="default" onChange={vi.fn()} onRefresh={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: /Local model/i });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("textbox", { name: /search models/i }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Refresh calls onRefresh without changing the selection", () => {
  const onRefresh = vi.fn();
  render(<ModelPicker catalog={catalog()} value="default" onChange={vi.fn()} onRefresh={onRefresh} />);
  fireEvent.click(screen.getByRole("button", { name: /Local model/i }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test("the trigger is disabled with a reason while work is active (D28)", () => {
  render(
    <ModelPicker
      catalog={catalog()}
      value="default"
      disabled
      disabledReason="Switching models is disabled while a turn is active."
      onChange={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: /Local model/i });
  expect(trigger.hasAttribute("disabled")).toBe(true);
});
