// @vitest-environment happy-dom
//
// T6 6.1 — containment/security tests, written before the Markdown pipeline exists.
// These pin the structural defence described in design.md D17/D18: react-markdown
// never parses raw HTML into elements, and our sanitize schema restricts link/image
// protocols. A `<script>` must never execute, an `onerror=` handler must never survive,
// a `javascript:` link must never become navigable, an image must render as a link
// (never an `<img>`), and an external link must always carry a safe `rel`.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";

afterEach(cleanup);

describe("MarkdownMessage containment", () => {
  it("does not execute or interpret a raw script tag", () => {
    const spy = vi.fn();
    (globalThis as { __xss?: () => void }).__xss = spy;
    const { container } = render(
      <MarkdownMessage content={"before <script>window.__xss()</script> after"} streaming={false} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("strips an inline event handler instead of rendering it", () => {
    const { container } = render(
      <MarkdownMessage content={'<img src="x" onerror="window.__xss()">'} streaming={false} />,
    );
    const img = container.querySelector("img");
    if (img !== null) {
      expect(img.getAttribute("onerror")).toBeNull();
    }
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("renders a javascript: link as plain text, not a navigable link", () => {
    const { container } = render(<MarkdownMessage content={"[click me](javascript:alert(1))"} streaming={false} />);
    const anchor = container.querySelector("a");
    expect(anchor).toBeNull();
    expect(container.textContent).toContain("click me");
  });

  it("renders an image as a link, not an <img>", () => {
    const { container } = render(
      <MarkdownMessage content={"![a diagram](https://example.com/diagram.png)"} streaming={false} />,
    );
    expect(container.querySelector("img")).toBeNull();
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("https://example.com/diagram.png");
  });

  it("adds a safe rel to an external link", () => {
    const { container } = render(<MarkdownMessage content={"[docs](https://example.com/docs)"} streaming={false} />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });
});
