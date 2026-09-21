import { useMemo } from "react";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { hasMarkdownSyntax } from "../../lib/markdown/has-markdown-syntax";
import { renderMarkdownCached } from "../../lib/markdown/render-cache";
import { sanitizeSchema } from "../../lib/markdown/sanitize-schema";
import { closeUnterminatedFence } from "../../lib/markdown/streaming-fence";
import { markdownUrlTransform } from "../../lib/markdown/url-transform";
import { hasWorkspacePathCandidate } from "../../lib/markdown/workspace-path-pattern";
import { CodeBlock } from "./CodeBlock";
import { MarkdownImage, MarkdownLink } from "./link-components";
import { MarkdownStreamingProvider } from "./MarkdownStreamingContext";
import { remarkWorkspacePaths } from "./remark-workspace-paths";

const REMARK_PLUGINS = [remarkGfm, remarkWorkspacePaths];
const REHYPE_PLUGINS: [typeof rehypeSanitize, typeof sanitizeSchema][] = [[rehypeSanitize, sanitizeSchema]];

const COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
  code: CodeBlock,
  // The `code` component owns its own `<pre>` for fenced blocks (CodeBlock);
  // unwrap remark-rehype's default `<pre>` wrapper so blocks aren't doubled.
  pre: ({ children }: { readonly children?: React.ReactNode }) => <>{children}</>,
};

/**
 * D17 — assistant message text renders through `react-markdown` with
 * `remark-gfm` (tables, task lists, strikethrough) and a restrictive
 * `rehype-sanitize` schema. No `rehype-raw`: raw HTML in model output is
 * never parsed into elements, only ever shown back as literal text (D17,
 * "Model output contains raw HTML"). D18 is the boundary that keeps this
 * component off tool output entirely — see `ToolActionCard`, which always
 * renders in `<pre>`.
 *
 * 6.5 — a short plain reply with no Markdown syntax and no workspace-path
 * candidate skips the parser entirely; anything else goes through a
 * content-hash-keyed cache (`renderMarkdownCached`) so re-rendering
 * unchanged text — the common case while sibling state changes during
 * streaming — never re-parses.
 */
export function MarkdownMessage({ content, streaming }: { readonly content: string; readonly streaming: boolean }) {
  // 6.4 — the fence-closing is display-only: it derives a value to render,
  // it never writes back to `content` (owned by the transport/store).
  const displayContent = useMemo(() => (streaming ? closeUnterminatedFence(content) : content), [content, streaming]);

  const plainText = useMemo(
    () => !hasMarkdownSyntax(displayContent) && !hasWorkspacePathCandidate(displayContent),
    [displayContent],
  );

  const rendered = useMemo(() => {
    if (plainText) return null;
    return renderMarkdownCached(displayContent, {
      components: COMPONENTS,
      rehypePlugins: REHYPE_PLUGINS,
      remarkPlugins: REMARK_PLUGINS,
      urlTransform: markdownUrlTransform,
    });
  }, [displayContent, plainText]);

  return (
    <div className="tt-markdown">
      <MarkdownStreamingProvider streaming={streaming}>
        {plainText ? <span className="tt-markdown-plain">{displayContent}</span> : rendered}
      </MarkdownStreamingProvider>
    </div>
  );
}
