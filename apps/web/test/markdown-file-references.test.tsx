// @vitest-environment happy-dom
//
// T6 6.6 — file references (D19): a workspace-relative path with a line
// number becomes an actionable reference; the same text inside inline or
// fenced code does not; activating it calls the injected `openFile` handler
// instead of navigating; the browser host's peek panel shows the region.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ChatTransport } from "@turnturn/chat-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePeekPanel } from "../src/components/markdown/FilePeekPanel";
import { FileReferenceProvider } from "../src/components/markdown/FileReferenceProvider";
import { MarkdownMessage } from "../src/components/markdown/MarkdownMessage";
import { WorkspaceFilePeekProvider } from "../src/features/file-preview/WorkspaceFilePeekProvider";
import { TransportProvider } from "../src/providers/TransportProvider";

afterEach(cleanup);

describe("workspace file references", () => {
  it("turns a path with a line number into a reference carrying the path and line", () => {
    const { container } = render(<MarkdownMessage content={"See src/app.ts:42 for the fix"} streaming={false} />);
    const anchor = container.querySelector("a[data-workspace-path]");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("data-workspace-path")).toBe("src/app.ts");
    expect(anchor?.getAttribute("data-line")).toBe("42");
  });

  it("does not turn a path inside inline code into a reference", () => {
    const { container } = render(<MarkdownMessage content={"run `src/app.ts:42`"} streaming={false} />);
    expect(container.querySelector("a[data-workspace-path]")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("src/app.ts:42");
  });

  it("does not turn a path inside a fenced code block into a reference", () => {
    const content = "```\nsrc/app.ts:42\n```";
    const { container } = render(<MarkdownMessage content={content} streaming={false} />);
    expect(container.querySelector("a[data-workspace-path]")).toBeNull();
    expect(container.textContent).toContain("src/app.ts:42");
  });

  it("calls the injected openFile handler instead of navigating on click", () => {
    const openFile = vi.fn();
    const { container } = render(
      <FileReferenceProvider openFile={openFile}>
        <MarkdownMessage content={"See src/app.ts:42 for the fix"} streaming={false} />
      </FileReferenceProvider>,
    );
    const anchor = container.querySelector("a[data-workspace-path]") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor);
    expect(openFile).toHaveBeenCalledWith({ path: "src/app.ts", line: 42 });
  });
});

describe("FilePeekPanel (browser host)", () => {
  it("renders a file region supplied by its controller", () => {
    const { getByText } = render(
      <FilePeekPanel
        onClose={() => {}}
        reference={{ path: "src/app.ts", line: 2 }}
        state={{
          status: "ready",
          region: { path: "src/app.ts", start: 1, end: 3, lineCount: 3, content: "a\nb\nc" },
        }}
      />,
    );
    expect(getByText("a")).toBeTruthy();
    expect(getByText("b")).toBeTruthy();
    expect(getByText("c")).toBeTruthy();
  });

  it("loads through ChatTransport and never touches browser-global fetch", async () => {
    const originalFetch = globalThis.fetch;
    const forbiddenFetch = vi.fn(() => {
      throw new Error("File preview bypassed ChatTransport");
    });
    globalThis.fetch = forbiddenFetch as typeof fetch;
    const getWorkspaceFile = vi.fn(async () => ({
      path: "src/app.ts",
      start: 1,
      end: 3,
      lineCount: 3,
      content: "a\nb\nc",
    }));
    const transport = { getWorkspaceFile } as unknown as ChatTransport;

    try {
      const { container, getByText } = render(
        <TransportProvider transport={transport}>
          <WorkspaceFilePeekProvider workspaceKey="ws1">
            <MarkdownMessage content={"See src/app.ts:2"} streaming={false} />
          </WorkspaceFilePeekProvider>
        </TransportProvider>,
      );
      fireEvent.click(container.querySelector("a[data-workspace-path]") as HTMLAnchorElement);
      await waitFor(() => expect(getByText("a")).toBeTruthy());
      expect(getWorkspaceFile).toHaveBeenCalledWith("ws1", "src/app.ts", 1, 200);
      expect(forbiddenFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
