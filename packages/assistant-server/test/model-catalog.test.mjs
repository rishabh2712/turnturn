import assert from "node:assert/strict";
import test from "node:test";
import { ModelCatalog } from "../dist/model-catalog.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("configured profiles are always listed and merged ahead of discovered entries", async () => {
  const catalog = new ModelCatalog(
    [{ id: "default", label: "Default", provider: "ollama", model: "local-model" }],
    "default",
    [
      {
        wire: "ollama",
        label: "Ollama (local)",
        locality: "local",
        discover: async () => ({
          status: "ok",
          models: [
            { modelId: "local-model", label: "duplicate of configured", toolCompatibility: "unknown" },
            { modelId: "other-model", label: "Other", toolCompatibility: "supported" },
          ],
        }),
      },
    ],
  );
  await catalog.refreshAll();
  const publicList = catalog.listPublic();
  // The configured profile shadows the discovered duplicate — no double listing of the same model.
  assert.equal(publicList.filter((p) => p.model === "local-model").length, 1);
  assert.ok(publicList.some((p) => p.model === "other-model"));

  const snapshot = catalog.providerSnapshot();
  const ollama = snapshot.connections.find((c) => c.id === "ollama");
  assert.equal(ollama.status, "ok");
  const configured = ollama.models.find((m) => m.model === "local-model");
  const discovered = ollama.models.find((m) => m.model === "other-model");
  assert.equal(configured.source, "configured");
  assert.equal(discovered.source, "discovered");
  assert.equal(discovered.toolCompatibility, "supported");
});

test("one failing provider leaves the others usable and leaves configured profiles intact", async () => {
  const catalog = new ModelCatalog(
    [{ id: "default", label: "Default", provider: "ollama", model: "local-model" }],
    "default",
    [
      {
        wire: "ollama",
        label: "Ollama",
        locality: "local",
        discover: async () => ({ status: "error", code: "TIMEOUT" }),
      },
      {
        wire: "anthropic-messages",
        label: "Anthropic",
        locality: "remote",
        apiKey: "sk-test",
        discover: async () => ({
          status: "ok",
          models: [{ modelId: "claude-x", label: "Claude X", toolCompatibility: "supported" }],
        }),
      },
    ],
  );
  await catalog.refreshAll();
  const snapshot = catalog.providerSnapshot();
  const ollama = snapshot.connections.find((c) => c.id === "ollama");
  const anthropic = snapshot.connections.find((c) => c.id === "anthropic-messages");
  assert.equal(ollama.status, "error");
  assert.equal(ollama.error.code, "TIMEOUT");
  // Configured profile for the failing connection is untouched.
  assert.ok(ollama.models.some((m) => m.model === "local-model" && m.source === "configured"));
  assert.equal(anthropic.status, "ok");
  assert.ok(anthropic.models.some((m) => m.model === "claude-x"));
  assert.equal(catalog.require("default").model, "local-model");
});

test("a later-started refresh wins even if an earlier-started one resolves after it", async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const catalog = new ModelCatalog([{ id: "default", label: "Default", provider: "ollama", model: "m" }], "default", [
    {
      wire: "ollama",
      label: "Ollama",
      locality: "local",
      discover: async () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    },
  ]);

  const refreshA = catalog.refreshAll();
  const refreshB = catalog.refreshAll();
  // B (started second) resolves first; A (started first) resolves after it.
  second.resolve({ status: "ok", models: [{ modelId: "from-b", label: "B", toolCompatibility: "unknown" }] });
  await refreshB;
  first.resolve({ status: "ok", models: [{ modelId: "from-a", label: "A", toolCompatibility: "unknown" }] });
  await refreshA;

  const snapshot = catalog.providerSnapshot();
  const ollama = snapshot.connections.find((c) => c.id === "ollama");
  assert.ok(
    ollama.models.some((m) => m.model === "from-b"),
    "the later-started refresh's result must be visible",
  );
  assert.ok(
    !ollama.models.some((m) => m.model === "from-a"),
    "the earlier-started refresh must not overwrite a newer result",
  );
});

test("a persisted profile reopens after its model disappears from discovery, but is not available for a new invocation", async () => {
  let discovered = [{ modelId: "vanishing", label: "Vanishing", toolCompatibility: "unknown" }];
  const catalog = new ModelCatalog(
    [{ id: "default", label: "Default", provider: "ollama", model: "keep" }],
    "default",
    [
      {
        wire: "ollama",
        label: "Ollama",
        locality: "local",
        discover: async () => ({ status: "ok", models: discovered }),
      },
    ],
  );
  await catalog.refreshAll();
  const snapshot1 = catalog.providerSnapshot();
  const profileId = snapshot1.connections[0].models.find((m) => m.model === "vanishing").id;
  assert.equal(catalog.isAvailable(profileId), true);

  discovered = [];
  await catalog.refreshAll();
  assert.equal(catalog.isAvailable(profileId), false);
  // require() still reconstructs it so an old session can reopen and stay readable.
  const reconstructed = catalog.require(profileId);
  assert.equal(reconstructed.model, "vanishing");
  assert.equal(reconstructed.provider, "ollama");
  // resolve() (used when reopening a session by its persisted identity) still succeeds.
  const resolved = catalog.resolve({ modelProfileId: profileId, provider: "ollama", model: "vanishing" });
  assert.equal(resolved.model, "vanishing");
});

test("require throws for an id whose connection was never configured", () => {
  const catalog = new ModelCatalog([{ id: "default", label: "Default", provider: "ollama", model: "m" }], "default");
  assert.throws(() => catalog.require("nonexistent"), /MODEL_PROFILE_NOT_FOUND/);
  assert.throws(() => catalog.require("openai-chat-completions__bm9wZQ"), /MODEL_PROFILE_NOT_FOUND/);
});
