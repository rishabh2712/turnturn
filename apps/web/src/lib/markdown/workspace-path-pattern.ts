/**
 * D19 — a conservative workspace-relative path pattern shared by the
 * `remark-workspace-paths` plugin (6.6) and the plain-text fast path (6.5):
 * either a path with a directory separator ending in an extension-like
 * suffix (`src/app.ts`), or a bare filename with a recognized code/text
 * extension (`README.md`), optionally followed by `:line` or `:line:col`.
 *
 * Bias is toward missing ambiguous cases rather than over-matching prose —
 * see D19: "A false negative is a plain string; a false positive mangles
 * prose."
 */
const KNOWN_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|md|mdx|yml|yaml|toml|css|scss|html|htm|sql|sh|bash|c|cpp|cc|h|hpp|java|rb|php|txt|lock|toml";

const PATH_WITH_SEPARATOR = String.raw`(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}`;
const BARE_FILE_WITH_KNOWN_EXTENSION = String.raw`[\w.-]+\.(?:${KNOWN_EXTENSIONS})`;
const LINE_COL_SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;

const PATTERN_SOURCE = String.raw`\b(${PATH_WITH_SEPARATOR}|${BARE_FILE_WITH_KNOWN_EXTENSION})(${LINE_COL_SUFFIX})`;

/** Always construct a fresh instance — a shared `g`-flagged regex is stateful across calls. */
export function createWorkspacePathPattern(): RegExp {
  return new RegExp(PATTERN_SOURCE, "g");
}

export interface WorkspacePathMatch {
  readonly text: string;
  readonly path: string;
  readonly line?: number;
  readonly index: number;
}

export function findWorkspacePathMatches(text: string): WorkspacePathMatch[] {
  const pattern = createWorkspacePathPattern();
  const matches: WorkspacePathMatch[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const path = match[1] ?? "";
    const suffix = match[2] ?? "";
    const lineMatch = /^:(\d+)/.exec(suffix);
    matches.push({
      text: match[0],
      path,
      line: lineMatch?.[1] === undefined ? undefined : Number(lineMatch[1]),
      index: match.index,
    });
    match = pattern.exec(text);
  }
  return matches;
}

export function hasWorkspacePathCandidate(text: string): boolean {
  return createWorkspacePathPattern().test(text);
}
