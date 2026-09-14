import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("chat-client builds a narrow, browser-safe package", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.type, "module");
  assert.deepEqual(Object.keys(manifest.dependencies), ["@turnturn/protocol"]);
  assert.deepEqual(Object.keys(manifest.exports), ["."]);

  const files = await builtFiles(join(packageRoot, "dist"));
  assert.ok(files.some((path) => path.endsWith("index.js")));
  assert.ok(files.some((path) => path.endsWith("index.d.ts")));
  for (const path of files) {
    if (!/\.(?:js|d\.ts)$/.test(path)) continue;
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /node:|@turnturn\/assistant-core/, path);
  }
});

async function builtFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? builtFiles(path) : [path];
    }),
  );
  return groups.flat();
}
