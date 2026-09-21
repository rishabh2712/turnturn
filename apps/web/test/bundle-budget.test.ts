// T6 6.7 — the Shiki subset's lazy-loaded chunks must stay under a bundle
// size budget. This exercises the checker against the real build output (it
// must currently pass) and against a synthetic oversized fixture (it must
// fail), so the check itself is proven to actually catch a regression.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { checkShikiBundleBudget, SHIKI_BUNDLE_BUDGET_BYTES } from "../scripts/bundle-budget.mjs";

const distAssetsDir = join(import.meta.dirname, "..", "dist", "assets");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("Shiki bundle budget", () => {
  it("passes against the current build output", () => {
    const result = checkShikiBundleBudget(distAssetsDir);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(result.totalGzipBytes).toBeLessThanOrEqual(SHIKI_BUNDLE_BUDGET_BYTES);
  });

  it("fails when a Shiki chunk is deliberately made oversized", () => {
    tempDir = mkdtempSync(join(tmpdir(), "shiki-budget-"));
    // Random (near-incompressible) bytes so gzip doesn't shrink it back under budget.
    const oversized = randomBytes(SHIKI_BUNDLE_BUDGET_BYTES + 1024);
    writeFileSync(join(tempDir, "typescript-deadbeef.js"), oversized);

    const result = checkShikiBundleBudget(tempDir);
    expect(result.ok).toBe(false);
    expect(result.totalGzipBytes).toBeGreaterThan(result.budgetBytes);
  });

  it("ignores files that are not part of the Shiki chunk set", () => {
    tempDir = mkdtempSync(join(tmpdir(), "shiki-budget-"));
    writeFileSync(join(tempDir, "index-deadbeef.js"), gzipSync(Buffer.alloc(1024 * 1024)));
    const result = checkShikiBundleBudget(tempDir);
    expect(result.files.length).toBe(0);
    expect(result.ok).toBe(true);
  });
});
