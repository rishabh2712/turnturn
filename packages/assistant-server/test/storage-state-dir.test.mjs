import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStateDirectory } from "../dist/storage/state-dir.js";

test("fresh state directory writes version metadata outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-state-test-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspace);
  try {
    const state = await openStateDirectory({ workspace, stateRoot, port: 8787 });
    try {
      assert.deepEqual(JSON.parse(await readFile(join(stateRoot, "meta.json"), "utf8")), { storageVersion: 1 });
      assert.match(state.workspaceKey, /^[0-9a-f]{16}$/);
      assert.deepEqual(JSON.parse(await readFile(join(state.workspaceDir, "workspace.json"), "utf8")), {
        path: await realpath(workspace),
        createdAt: state.createdAt,
      });
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      await state.close();
    }
    assert.equal((await readdir(stateRoot)).includes(".lock"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("future storage version refuses to start without modifying the directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-state-test-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspace);
  await mkdir(stateRoot);
  await writeFile(join(stateRoot, "meta.json"), '{"storageVersion":99}\n');
  try {
    const before = await readdir(stateRoot);
    await assert.rejects(openStateDirectory({ workspace, stateRoot }), /storage version 99.*supports 1/i);
    assert.deepEqual(await readdir(stateRoot), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second writer is refused while the first holds the state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-state-test-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspace);
  try {
    const first = await openStateDirectory({ workspace, stateRoot, port: 8787 });
    try {
      await assert.rejects(openStateDirectory({ workspace, stateRoot, port: 8788 }), /already held by pid/);
      const lock = JSON.parse(await readFile(join(stateRoot, ".lock"), "utf8"));
      assert.equal(lock.pid, process.pid);
      assert.equal(lock.port, 8787);
    } finally {
      await first.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
