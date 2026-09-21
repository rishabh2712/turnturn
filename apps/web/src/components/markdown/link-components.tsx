import type { ComponentProps } from "react";
import { ALLOWED_LINK_PROTOCOLS } from "../../lib/markdown/sanitize-schema";
import { useFileReference } from "./FileReferenceProvider";

function schemeOf(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  return match?.[1]?.toLowerCase();
}

function isAllowedHttpLikeScheme(scheme: string | undefined): boolean {
  return scheme !== undefined && (ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(scheme);
}

/**
 * 6.1/D17 — anchors reaching this component already passed `rehype-sanitize`
 * (bad-protocol hrefs are stripped there), but sanitize only drops the
 * attribute, not the element. This is the second layer: without a safe
 * `href` there is nothing to navigate to, so we render the link text as
 * plain content instead of an inert `<a>`. Workspace file references (D19)
 * are recognized by their `data-workspace-path` attribute and handed to the
 * `FileReferenceProvider`, never left to navigate.
 */
export function MarkdownLink(props: ComponentProps<"a"> & { readonly node?: unknown }) {
  const { href, children, node: _node, ...rest } = props;
  const openFile = useFileReference();
  const workspacePath = (props as Record<string, unknown>)["data-workspace-path"] as string | undefined;

  if (workspacePath !== undefined) {
    const lineAttr = (props as Record<string, unknown>)["data-line"] as string | undefined;
    return (
      <a
        {...rest}
        href={href}
        data-workspace-path={workspacePath}
        data-line={lineAttr}
        onClick={(event) => {
          event.preventDefault();
          openFile({ path: workspacePath, line: lineAttr === undefined ? undefined : Number(lineAttr) });
        }}
      >
        {children}
      </a>
    );
  }

  const scheme = schemeOf(href);
  if (!isAllowedHttpLikeScheme(scheme)) {
    return <>{children}</>;
  }

  const external = scheme === "http" || scheme === "https";
  return (
    <a
      {...rest}
      href={href}
      rel={external ? "noopener noreferrer nofollow" : undefined}
      target={external ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}

/**
 * 6.1 — model output can request an image, but the client never fetches or
 * embeds one: an `![alt](src)` renders as a link to `src` instead of an
 * `<img>`, avoiding both a request side channel and layout surprises.
 */
export function MarkdownImage(props: ComponentProps<"img"> & { readonly node?: unknown }) {
  const { src, alt, node: _node } = props;
  const label = alt !== undefined && alt.length > 0 ? alt : src;
  if (src === undefined) return <>{label}</>;
  const scheme = schemeOf(src);
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return <>{label}</>;
  return (
    <a href={src} rel="noopener noreferrer nofollow" target="_blank">
      {label}
    </a>
  );
}
