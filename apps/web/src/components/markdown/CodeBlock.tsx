import { type ComponentProps, useEffect, useState } from "react";
import { highlightCode, resolveSupportedLang, type SupportedLang } from "../../lib/markdown/shiki-loader";
import { useMarkdownStreaming } from "./MarkdownStreamingContext";

/** 6.3 — blocks past this size render unhighlighted rather than through Shiki. */
export const MAX_HIGHLIGHT_LINES = 2000;
export const MAX_HIGHLIGHT_BYTES = 100 * 1024;

function extractLanguage(className: string | undefined): string | undefined {
  const match = /language-(\S+)/.exec(className ?? "");
  return match?.[1];
}

function textOf(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function CopyButton({ source }: { readonly source: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tt-code-copy"
      onClick={() => {
        // Copies the exact original source, never the highlighted HTML.
        void navigator.clipboard.writeText(source).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function HighlightedBody({ source, lang }: { readonly source: string; readonly lang: SupportedLang }) {
  const [html, setHtml] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setHtml(undefined);
    void highlightCode(source, lang).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [source, lang]);

  if (html === undefined) {
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  }
  // Shiki's output is generated from our own tokenizer against text we control
  // the escaping of; it contains no attacker-authored markup, so this is not
  // an XSS surface the way `dangerouslySetInnerHTML` normally would be.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: see above — Shiki output, not raw model HTML.
  return <div className="tt-shiki-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 6.2/6.3 — react-markdown wraps fenced code in `<pre><code
 * className="language-x">`; we take over the `code` renderer for the block
 * case (className present) and own our own `<pre>` (see `pre` override in
 * `MarkdownMessage`) so we can attach a copy button and lazily-loaded Shiki
 * highlighting. Inline code (no className) stays a plain `<code>`.
 *
 * 6.4 — while the enclosing message is still streaming, highlighting is
 * skipped entirely (plain text only) so a mid-token partial line never gets
 * tokenized.
 */
export function CodeBlock(props: ComponentProps<"code"> & { readonly node?: unknown }) {
  const { className, children, node: _node, ...rest } = props;
  const streaming = useMarkdownStreaming();
  const language = extractLanguage(className);
  const source = textOf(children).replace(/\n$/, "");

  if (language === undefined) {
    return (
      <code {...rest} className={className}>
        {children}
      </code>
    );
  }

  const resolvedLang = resolveSupportedLang(language);
  const oversized = source.split("\n").length > MAX_HIGHLIGHT_LINES || byteLength(source) > MAX_HIGHLIGHT_BYTES;
  const canHighlight = resolvedLang !== undefined && !oversized && !streaming;

  return (
    <div className="tt-code-block" data-language={language}>
      <div className="tt-code-block-toolbar">
        <span className="tt-code-block-language">{resolvedLang ?? language}</span>
        <CopyButton source={source} />
      </div>
      {canHighlight ? (
        <HighlightedBody lang={resolvedLang} source={source} />
      ) : (
        <pre>
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
