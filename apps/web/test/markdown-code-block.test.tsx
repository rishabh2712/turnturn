// @vitest-environment happy-dom
//
// T6 6.3 — Shiki-backed code renderer: lazy highlighting, a copy button that
// copies the exact original source, and an explicit plain-text fallback for
// oversized or unrecognized-language blocks.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";

afterEach(cleanup);

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

describe("MarkdownMessage code blocks", () => {
  it("renders unhighlighted immediately, then highlighted once Shiki loads", async () => {
    const { container } = render(<MarkdownMessage content={fence("ts", "const x: number = 1;")} streaming={false} />);
    const block = container.querySelector(".tt-code-block");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("const x: number = 1;");

    await waitFor(() => {
      expect(block?.querySelector(".tt-shiki-body")).not.toBeNull();
    });
    expect(block?.querySelector(".tt-shiki-body span")).not.toBeNull();
    // The original text must still be recoverable from the highlighted markup.
    expect(block?.textContent).toContain("const x: number = 1;");
  });

  it("keeps toolbar controls outside preformatted content and never nests pre elements", async () => {
    const { container } = render(<MarkdownMessage content={fence("ts", "const x = 1;")} streaming={false} />);
    const block = container.querySelector(".tt-code-block");
    expect(block?.tagName).toBe("DIV");
    expect(block?.querySelector(".tt-code-block-toolbar")?.closest("pre")).toBeNull();
    await waitFor(() => expect(block?.querySelector(".tt-shiki-body")).not.toBeNull());
    expect(block?.querySelectorAll("pre").length).toBe(1);
    expect(block?.querySelector("pre pre")).toBeNull();
  });

  it("copies the exact original source, not the highlighted HTML", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const source = "def add(a, b):\n    return a + b";
    const { container } = render(<MarkdownMessage content={fence("python", source)} streaming={false} />);
    const button = container.querySelector("button.tt-code-copy") as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });

  it("renders an unrecognized language as plain text without throwing", async () => {
    const { container } = render(<MarkdownMessage content={fence("cobol", "MOVE 0 TO COUNTER.")} streaming={false} />);
    const block = container.querySelector(".tt-code-block");
    expect(block?.textContent).toContain("MOVE 0 TO COUNTER.");
    expect(block?.querySelector(".tt-shiki-body")).toBeNull();
  });

  it("renders an oversized block as plain text without throwing", async () => {
    const bigSource = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const { container } = render(<MarkdownMessage content={fence("ts", bigSource)} streaming={false} />);
    const block = container.querySelector(".tt-code-block");
    expect(block?.textContent).toContain("line 0");
    expect(block?.querySelector(".tt-shiki-body")).toBeNull();
  });
});
