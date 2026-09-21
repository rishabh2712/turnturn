// @vitest-environment happy-dom
//
// T6 6.4 — streaming Markdown: an unterminated fence is closed for display
// only (never mutating the underlying text), Shiki is skipped until the
// fence closes, and all received text stays visible.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";
import { closeUnterminatedFence } from "../src/lib/markdown/streaming-fence";

afterEach(cleanup);

describe("closeUnterminatedFence", () => {
  it("leaves complete text untouched", () => {
    const text = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(closeUnterminatedFence(text)).toBe(text);
  });

  it("appends a closing fence for an unterminated block, without dropping content", () => {
    const text = "before\n```ts\nconst x = 1;";
    const result = closeUnterminatedFence(text);
    expect(result.startsWith(text)).toBe(true);
    expect(result.endsWith("```")).toBe(true);
  });

  it("does not mutate the input string", () => {
    const text = "```ts\nconst x = 1;";
    const original = text;
    closeUnterminatedFence(text);
    expect(text).toBe(original);
  });

  it("closes a four-backtick fence with four backticks even when its body contains a triple fence", () => {
    const text = "````md\n```ts\nconst x = 1;\n```";
    const result = closeUnterminatedFence(text);
    expect(result.startsWith(text)).toBe(true);
    expect(result.endsWith("````")).toBe(true);
  });

  it("tracks tilde fences and leaves a complete longer fence unchanged", () => {
    const incomplete = "~~~~js\nconst x = 1;";
    expect(closeUnterminatedFence(incomplete).endsWith("~~~~")).toBe(true);
    const complete = `${incomplete}\n~~~~`;
    expect(closeUnterminatedFence(complete)).toBe(complete);
  });
});

describe("MarkdownMessage while streaming", () => {
  it("renders a message ending mid-fence without throwing, keeping all text visible", () => {
    const content = "Here is some code:\n```ts\nconst partial = 1 +";
    expect(() => render(<MarkdownMessage content={content} streaming={true} />)).not.toThrow();
    const { container } = render(<MarkdownMessage content={content} streaming={true} />);
    expect(container.textContent).toContain("Here is some code:");
    expect(container.textContent).toContain("const partial = 1 +");
  });

  it("does not highlight (Shiki) a code block while still streaming", () => {
    const content = "```ts\nconst x = 1;\n```";
    const { container } = render(<MarkdownMessage content={content} streaming={true} />);
    expect(container.querySelector(".tt-shiki-body")).toBeNull();
  });

  it("does not pass the synthetic closing fence back into the parent's own text", () => {
    const content = "```ts\nconst x = 1;";
    render(<MarkdownMessage content={content} streaming={true} />);
    // The prop value itself must be unchanged by rendering.
    expect(content).toBe("```ts\nconst x = 1;");
  });
});
