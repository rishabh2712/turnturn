import { defaultSchema } from "rehype-sanitize";

/**
 * D17/6.2 — a restrictive `rehype-sanitize` schema layered on top of GitHub's
 * default. react-markdown never parses raw HTML into elements (no `rehype-raw`
 * in the pipeline), so `<script>` and `onerror=` cannot become real nodes at
 * all; this schema narrows what *does* reach real elements: link/image
 * protocols are limited to an allowlist, and our own `turnturn://` file
 * references (D19) get an allowance for the scheme plus the two data
 * attributes `remark-workspace-paths` attaches.
 */
export type SanitizeSchema = typeof defaultSchema;

/** URL schemes assistant text may link to. No `javascript:`, no `data:`. */
export const ALLOWED_LINK_PROTOCOLS = ["http", "https", "mailto"] as const;

/** The pseudo-scheme used for file references (D19). Never resolved by the browser. */
export const WORKSPACE_FILE_PROTOCOL = "turnturn";

export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...ALLOWED_LINK_PROTOCOLS, WORKSPACE_FILE_PROTOCOL],
    src: ["http", "https"],
  },
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "href", "target", "rel", "dataWorkspacePath", "dataLine"],
  },
};
