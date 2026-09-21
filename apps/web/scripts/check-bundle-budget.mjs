#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkShikiBundleBudget } from "./bundle-budget.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(here, "../dist/assets");

const result = checkShikiBundleBudget(assetsDir);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`Shiki bundle budget: ${kb(result.totalGzipBytes)} / ${kb(result.budgetBytes)} gzip`);
for (const file of result.files) {
  console.log(`  ${file.name}: ${kb(file.gzipBytes)}`);
}

if (!result.ok) {
  console.error(
    `\nShiki bundle budget exceeded: ${kb(result.totalGzipBytes)} > ${kb(result.budgetBytes)} gzip. ` +
      "See the budget comment in scripts/bundle-budget.mjs before raising it — this usually means a new " +
      `language or an unbounded shared chunk got pulled into the lazy Shiki load path. (Checked ${join(assetsDir)}.)`,
  );
  process.exit(1);
}
