import type { Parent, Text } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { findWorkspacePathMatches } from "../../lib/markdown/workspace-path-pattern";

/**
 * D19 — turns a bare workspace-relative path in prose into a file-reference
 * anchor. `visit(tree, "text", ...)` only ever calls back on mdast `text`
 * nodes; `inlineCode` and fenced `code` are separate leaf node types that
 * hold their content in a `value` string, not as `text` children, so this
 * plugin structurally never sees inside them — no extra guard needed for
 * "never inside inline code or fenced code blocks".
 */
export const remarkWorkspacePaths: Plugin = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return;
    const matches = findWorkspacePathMatches(node.value);
    if (matches.length === 0) return;

    const replacement: Array<Text | ReturnType<typeof linkNode>> = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.index > cursor) {
        replacement.push({ type: "text", value: node.value.slice(cursor, match.index) });
      }
      replacement.push(linkNode(match.text, match.path, match.line));
      cursor = match.index + match.text.length;
    }
    if (cursor < node.value.length) {
      replacement.push({ type: "text", value: node.value.slice(cursor) });
    }

    parent.children.splice(index, 1, ...replacement);
    // Skip back over the nodes we just inserted rather than re-visiting them.
    return index + replacement.length;
  });
};

function linkNode(label: string, path: string, line: number | undefined) {
  const query = line === undefined ? "" : `?line=${line}`;
  return {
    type: "link" as const,
    url: `turnturn://file/${path}${query}`,
    title: null,
    children: [{ type: "text" as const, value: label }],
    data: {
      hProperties: {
        dataWorkspacePath: path,
        ...(line === undefined ? {} : { dataLine: String(line) }),
      },
    },
  };
}
