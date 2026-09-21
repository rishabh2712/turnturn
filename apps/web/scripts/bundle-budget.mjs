import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Mirrors `SUPPORTED_LANGS` in `src/lib/markdown/shiki-loader.ts`. Duplicated
// rather than imported because this script runs directly with `node` against
// a built `dist/`, outside the app's TypeScript/bundler graph.
const SHIKI_LANGS = [
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
];
const SHIKI_SHARED_CHUNKS = ["core", "engine-javascript", "github-dark"];
const SHIKI_CHUNK_NAMES = [...SHIKI_LANGS, ...SHIKI_SHARED_CHUNKS];

// vite emits `<name>-<hash>.js`; anchor on the name followed by `-` so e.g.
// "css" doesn't accidentally match an unrelated "csslonger-*" chunk.
const SHIKI_CHUNK_PATTERN = new RegExp(`^(?:${SHIKI_CHUNK_NAMES.join("|")})-[\\w-]+\\.m?js$`);

/**
 * T6 6.7 — budget for every lazily-loaded Shiki chunk combined (the fixed
 * language subset from D17, plus the shared core/engine/theme chunks that
 * load once regardless of which language is first highlighted).
 *
 * 250 KB gzip: on 2026-09-20, the full 16-language subset plus core, the JS
 * regex engine, and one theme measured ~183 KB gzip combined (see
 * `apps/web/test/bundle-budget.test.ts` for the up-to-date measurement).
 * None of this loads eagerly and no single code block pulls in more than
 * core + engine + theme + one language (~70 KB gzip) — the budget bounds the
 * *whole fixed subset* so a future grammar-set change stays a deliberate
 * decision, with roughly 35% headroom over the current measurement for
 * grammar/engine version bumps before the check has to be revisited.
 */
export const SHIKI_BUNDLE_BUDGET_BYTES = 250 * 1024;

/**
 * @param {string} assetsDir absolute path to the built `assets/` directory.
 * @returns {{ files: { name: string; gzipBytes: number }[]; totalGzipBytes: number }}
 */
export function measureShikiBundle(assetsDir) {
  const entries = readdirSync(assetsDir).filter((name) => SHIKI_CHUNK_PATTERN.test(name));
  const files = entries.map((name) => {
    const contents = readFileSync(join(assetsDir, name));
    return { name, gzipBytes: gzipSync(contents).length };
  });
  const totalGzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return { files, totalGzipBytes };
}

/**
 * @param {string} assetsDir
 * @param {number} [budgetBytes]
 * @returns {{ ok: boolean; totalGzipBytes: number; budgetBytes: number; files: { name: string; gzipBytes: number }[] }}
 */
export function checkShikiBundleBudget(assetsDir, budgetBytes = SHIKI_BUNDLE_BUDGET_BYTES) {
  const { files, totalGzipBytes } = measureShikiBundle(assetsDir);
  return { ok: totalGzipBytes <= budgetBytes, totalGzipBytes, budgetBytes, files };
}
