// @vitest-environment happy-dom
//
// T6 6.2 — headings, lists, tables (remark-gfm), blockquotes, and inline
// code render as real elements through the Markdown pipeline.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";

afterEach(cleanup);

describe("MarkdownMessage rendering", () => {
  it("renders a heading", () => {
    const { container } = render(<MarkdownMessage content={"# Title"} streaming={false} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
  });

  it("renders an unordered list", () => {
    const { container } = render(<MarkdownMessage content={"- one\n- two"} streaming={false} />);
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe("one");
  });

  it("renders a GFM table", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { container } = render(<MarkdownMessage content={table} streaming={false} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("th").length).toBe(2);
    expect(container.querySelectorAll("td").length).toBe(2);
  });

  it("renders a blockquote", () => {
    const { container } = render(<MarkdownMessage content={"> quoted text"} streaming={false} />);
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted text");
  });

  it("renders inline code", () => {
    const { container } = render(<MarkdownMessage content={"use `const x = 1`"} streaming={false} />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("const x = 1");
    expect(code?.closest("pre")).toBeNull();
  });
});
