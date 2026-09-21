// @vitest-environment happy-dom
//
// Rishabh's browser check of 6.2 found numbered/bulleted lists rendering
// with stray vertical gaps (marker separated from its item, paragraph-style
// spacing per `<li>`). This pins the DOM shape react-markdown produces and
// asserts the scoped `.tt-markdown` CSS rules exist to collapse it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(resolve(here, "../src/styles.css"), "utf8");

describe("Markdown list rendering", () => {
  it("renders a numbered list as ol > li, marker and text as one item", () => {
    const { container } = render(<MarkdownMessage content={"1. first\n2. second"} streaming={false} />);
    const list = container.querySelector(".tt-markdown ol");
    expect(list).not.toBeNull();
    const items = list?.querySelectorAll(":scope > li") ?? [];
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe("first");
  });

  it("renders a bulleted list as ul > li", () => {
    const { container } = render(<MarkdownMessage content={"- one\n- two"} streaming={false} />);
    const list = container.querySelector(".tt-markdown ul");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll(":scope > li").length).toBe(2);
  });

  it("scopes list CSS under .tt-markdown with explicit markers and collapsed item-paragraph spacing", () => {
    expect(stylesheet).toMatch(/\.tt-markdown ul\s*\{[^}]*list-style:\s*disc/);
    expect(stylesheet).toMatch(/\.tt-markdown ol\s*\{[^}]*list-style:\s*decimal/);
    expect(stylesheet).toMatch(/\.tt-markdown li > p\s*\{[^}]*margin:\s*0/);
  });
});
