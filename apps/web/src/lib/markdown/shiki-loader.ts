import type { HighlighterCore } from "shiki/core";

/**
 * D17 — Shiki ships a fixed language subset so the lazily-loaded chunk is a
 * decision, not an accident (see 6.7's bundle-size budget). Anything outside
 * this set, and anything over the size guard in `CodeBlock`, renders
 * unhighlighted rather than pulling in more grammars.
 */
export const SUPPORTED_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "python",
  "rust",
  "go",
  "bash",
  "diff",
  "yaml",
  "toml",
  "markdown",
  "sql",
  "html",
  "css",
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANG_ALIASES: Record<string, SupportedLang> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  htm: "html",
};

export function resolveSupportedLang(raw: string): SupportedLang | undefined {
  const lower = raw.trim().toLowerCase();
  if ((SUPPORTED_LANGS as readonly string[]).includes(lower)) return lower as SupportedLang;
  return LANG_ALIASES[lower];
}

// Explicit per-language import functions (rather than a templated dynamic
// import) so the bundler can statically see and split each grammar chunk,
// and so only the language a given code block actually needs is ever
// fetched — not the whole fixed subset every time any block highlights.
const LANG_LOADERS: Record<SupportedLang, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
};

export const SHIKI_THEME = "github-dark";

let highlighterPromise: Promise<HighlighterCore> | undefined;
const loadedLangs = new Map<SupportedLang, Promise<void>>();

/**
 * Lazily loaded and cached: only the shared core + JS regex engine + theme
 * load up front (no grammars). Each language is fetched and registered on
 * its own, the first time a block actually needs it.
 */
function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === undefined) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-dark.mjs"),
      ]);
      return createHighlighterCore({
        langs: [],
        themes: [theme.default ?? theme],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

function ensureLangLoaded(highlighter: HighlighterCore, lang: SupportedLang): Promise<void> {
  let loading = loadedLangs.get(lang);
  if (loading === undefined) {
    loading = LANG_LOADERS[lang]().then(async (mod) => {
      // biome-ignore lint/suspicious/noExplicitAny: shiki's per-grammar module default export typing isn't worth threading through here.
      await highlighter.loadLanguage(mod as any);
    });
    loadedLangs.set(lang, loading);
  }
  return loading;
}

export async function highlightCode(code: string, lang: SupportedLang): Promise<string> {
  const highlighter = await loadHighlighter();
  await ensureLangLoaded(highlighter, lang);
  return highlighter.codeToHtml(code, { lang, theme: SHIKI_THEME });
}
