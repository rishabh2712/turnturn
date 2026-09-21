// @vitest-environment happy-dom
//
// T6 6.5 — a content-hash-keyed LRU cache of parsed Markdown output, plus a
// cheap "does this even contain Markdown" pre-check so short plain replies
// skip the parser entirely.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";
import { hasMarkdownSyntax } from "../src/lib/markdown/has-markdown-syntax";
import { LruCache } from "../src/lib/markdown/lru-cache";
import { getMarkdownParseCountForTests, resetMarkdownParseCountForTests } from "../src/lib/markdown/render-cache";

afterEach(cleanup);

describe("hasMarkdownSyntax", () => {
  it("is false for a short plain reply", () => {
    expect(hasMarkdownSyntax("Done.")).toBe(false);
    expect(hasMarkdownSyntax("Sounds good, I will proceed.")).toBe(false);
  });

  it("is true for text with Markdown-significant characters", () => {
    expect(hasMarkdownSyntax("# Heading")).toBe(true);
    expect(hasMarkdownSyntax("- one\n- two")).toBe(true);
    expect(hasMarkdownSyntax("use `code`")).toBe(true);
    expect(hasMarkdownSyntax("a [link](https://example.com)")).toBe(true);
  });
});

describe("LruCache", () => {
  it("returns what was set", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("evicts the least recently used entry once over capacity", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // "a" is now most-recently-used; "b" is the LRU entry.
    cache.set("c", 3); // should evict "b", not "a".
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe("Markdown parse cache integration", () => {
  it("does not re-parse unchanged content across re-renders", () => {
    resetMarkdownParseCountForTests();
    const content = "# Heading with **bold** text";
    render(<MarkdownMessage content={content} streaming={false} />);
    const afterFirst = getMarkdownParseCountForTests();
    expect(afterFirst).toBeGreaterThan(0);

    // A brand-new mount with the exact same content should hit the cache.
    render(<MarkdownMessage content={content} streaming={false} />);
    expect(getMarkdownParseCountForTests()).toBe(afterFirst);
  });

  it("does parse distinct content separately", () => {
    resetMarkdownParseCountForTests();
    render(<MarkdownMessage content={"# One"} streaming={false} />);
    const afterFirst = getMarkdownParseCountForTests();
    render(<MarkdownMessage content={"# Two, a different heading"} streaming={false} />);
    expect(getMarkdownParseCountForTests()).toBeGreaterThan(afterFirst);
  });

  it("never returns another message when two equal-length inputs share the same hash", () => {
    resetMarkdownParseCountForTests();
    // These two 12-character prefixes collide under the current 32-bit FNV-1a hash.
    // Appending the same Markdown suffix preserves both the hash collision and length.
    const first = "tBEk0LpozS5w\n**bold**";
    const second = "CrNS1WUg8JDl\n**bold**";
    expect(first).not.toBe(second);

    render(<MarkdownMessage content={first} streaming={false} />);
    const { container } = render(<MarkdownMessage content={second} streaming={false} />);

    expect(container.textContent).toContain("CrNS1WUg8JDl");
    expect(container.textContent).not.toContain("tBEk0LpozS5w");
  });
});
