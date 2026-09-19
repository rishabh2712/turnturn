import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnthropicApiKey } from "../dist/credentials.js";

test("a configured credential wins without invoking a helper", async () => {
  let called = false;
  const credential = await resolveAnthropicApiKey({
    environment: { ANTHROPIC_API_KEY: " direct-secret " },
    run: async () => {
      called = true;
      return { stdout: "wrong" };
    },
  });
  assert.equal(credential, "direct-secret");
  assert.equal(called, false);
});

test("an absolute custom helper supplies a trimmed credential", async () => {
  const calls = [];
  const credential = await resolveAnthropicApiKey({
    environment: { ANTHROPIC_API_KEY_HELPER: "/safe/helper" },
    platform: "linux",
    run: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: "helper-secret\n" };
    },
  });
  assert.equal(credential, "helper-secret");
  assert.deepEqual(calls, [{ executable: "/safe/helper", args: [] }]);
});

test("macOS falls back to the conventional Keychain item", async () => {
  const calls = [];
  const credential = await resolveAnthropicApiKey({
    environment: { USER: "rishabh", TURNTURN_ANTHROPIC_KEYCHAIN_SERVICE: "turnturn-test" },
    platform: "darwin",
    run: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: "keychain-secret\n" };
    },
  });
  assert.equal(credential, "keychain-secret");
  assert.deepEqual(calls, [
    {
      executable: "/usr/bin/security",
      args: ["find-generic-password", "-a", "rishabh", "-s", "turnturn-test", "-w"],
    },
  ]);
});

test("helper failures never copy command output into the reported error", async () => {
  await assert.rejects(
    () =>
      resolveAnthropicApiKey({
        environment: { ANTHROPIC_API_KEY_HELPER: "/safe/helper" },
        run: async () => {
          throw new Error("stderr contained secret-value");
        },
      }),
    (error) => {
      assert.doesNotMatch(error.message, /secret-value/);
      assert.match(error.message, /Could not load/);
      return true;
    },
  );
});

test("relative helpers and multiline output are rejected", async () => {
  await assert.rejects(
    () => resolveAnthropicApiKey({ environment: { ANTHROPIC_API_KEY_HELPER: "./helper" } }),
    /absolute executable path/,
  );
  await assert.rejects(
    () =>
      resolveAnthropicApiKey({
        environment: { ANTHROPIC_API_KEY_HELPER: "/safe/helper" },
        run: async () => ({ stdout: "line-one\nline-two\n" }),
      }),
    /invalid value/,
  );
});
