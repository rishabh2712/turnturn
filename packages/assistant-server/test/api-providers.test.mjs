import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantHttpServer, createAssistantRuntime, createPersistentRuntime } from "../dist/index.js";

const SECRET_API_KEY = "sk-super-secret-value-never-leak";
const SECRET_HELPER_PATH = "/opt/turnturn/secret-helper.sh";
const SECRET_QUERY_PARAM = "private_query_token_xyz";
const SECRET_AUTH_HEADER = "Bearer secret-authorization-header-value";
const PRIVATE_BASE_URL = "http://internal-gateway.private.example:4000";

async function start(root, discoveryOutcome) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runtime = createAssistantRuntime({
    workspace,
    provider: "ollama",
    model: "test",
    modelProfiles: [
      {
        id: "default",
        label: "Default",
        provider: "ollama",
        model: "test",
        apiKey: SECRET_API_KEY,
        baseUrl: PRIVATE_BASE_URL,
      },
    ],
    defaultModelProfileId: "default",
    discoveryConnections: [
      {
        wire: "ollama",
        label: "Ollama (local)",
        locality: "local",
        apiKey: SECRET_API_KEY,
        baseUrl: `${PRIVATE_BASE_URL}?token=${SECRET_QUERY_PARAM}`,
        discover: async () =>
          discoveryOutcome ?? {
            status: "ok",
            models: [{ modelId: "discovered-model", label: "Discovered", toolCompatibility: "unknown" }],
          },
      },
    ],
  });
  const persistent = await createPersistentRuntime(runtime, { stateRoot: join(root, "state") });
  const server = createAssistantHttpServer({ runtime, persistent, token: "test-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    persistent,
    address,
    workspaceKey: persistent.state.workspaceKey,
    json: async (path, method = "GET", body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { "x-turnturn-token": "test-token", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, text, body: text.length === 0 ? null : JSON.parse(text) };
    },
    close: async () => {
      server.close();
      await once(server, "close");
      await persistent.close();
    },
  };
}

function assertNoLeak(text) {
  assert.doesNotMatch(text, new RegExp(SECRET_API_KEY));
  assert.doesNotMatch(text, new RegExp(SECRET_HELPER_PATH.replace(/\//g, "\\/")));
  assert.doesNotMatch(text, new RegExp(SECRET_QUERY_PARAM));
  assert.doesNotMatch(text, new RegExp(SECRET_AUTH_HEADER));
  assert.doesNotMatch(text, new RegExp(PRIVATE_BASE_URL.replace(/[.:/]/g, "\\$&")));
}

test("GET /api/providers groups configured and discovered models by connection without leaking credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-providers-test-"));
  const harness = await start(root);
  try {
    const response = await harness.json("/api/providers");
    assert.equal(response.status, 200);
    assertNoLeak(response.text);
    const ollama = response.body.connections.find((c) => c.id === "ollama");
    assert.ok(ollama);
    assert.equal(ollama.wire, "ollama");
    assert.ok(ollama.models.some((m) => m.model === "test" && m.source === "configured"));
    assert.ok(ollama.models.some((m) => m.model === "discovered-model" && m.source === "discovered"));
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/providers/refresh re-runs discovery, is token-protected, and reflects the new snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-providers-refresh-test-"));
  const harness = await start(root, {
    status: "ok",
    models: [{ modelId: "fresh-model", label: "Fresh", toolCompatibility: "supported" }],
  });
  try {
    const noToken = await fetch(`http://127.0.0.1:${harness.address.port}/api/providers/refresh`, { method: "POST" });
    assert.equal(noToken.status, 401);

    const refreshed = await harness.json("/api/providers/refresh", "POST");
    assert.equal(refreshed.status, 200);
    assertNoLeak(refreshed.text);
    const ollama = refreshed.body.connections.find((c) => c.id === "ollama");
    assert.ok(ollama.models.some((m) => m.model === "fresh-model"));
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider connection error never leaks its raw status body and never removes configured profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-providers-error-test-"));
  const harness = await start(root, { status: "error", code: "UNAUTHORIZED" });
  try {
    const response = await harness.json("/api/providers");
    assertNoLeak(response.text);
    const ollama = response.body.connections.find((c) => c.id === "ollama");
    assert.equal(ollama.status, "error");
    assert.equal(ollama.error.code, "UNAUTHORIZED");
    assert.ok(ollama.models.some((m) => m.model === "test" && m.source === "configured"));

    const runtime = await harness.json("/api/runtime");
    assertNoLeak(JSON.stringify(runtime.body));

    const notFound = await harness.json("/api/does-not-exist");
    assert.equal(notFound.status, 404);
    assertNoLeak(notFound.text);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("activating a model that has disappeared from discovery is rejected before any provider construction", async () => {
  let discovered = [{ modelId: "here-for-now", label: "Here for now", toolCompatibility: "unknown" }];
  const root = await mkdtemp(join(tmpdir(), "turnturn-providers-drift-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runtime = createAssistantRuntime({
    workspace,
    provider: "ollama",
    model: "keep",
    modelProfiles: [{ id: "default", label: "Default", provider: "ollama", model: "keep" }],
    defaultModelProfileId: "default",
    discoveryConnections: [
      {
        wire: "ollama",
        label: "Ollama",
        locality: "local",
        discover: async () => ({ status: "ok", models: discovered }),
      },
    ],
  });
  const persistent = await createPersistentRuntime(runtime, { stateRoot: join(root, "state") });
  const server = createAssistantHttpServer({ runtime, persistent, token: "test-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const json = async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "x-turnturn-token": "test-token", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  try {
    await runtime.models.refreshAll();
    const providers = await json("/api/providers");
    const modelProfileId = providers.body.connections
      .find((c) => c.id === "ollama")
      .models.find((m) => m.model === "here-for-now").id;

    const created = await json("/api/conversations", "POST", { workspaceKey: persistent.state.workspaceKey });
    const conversationId = created.body.conversation.conversationId;
    const ok = await json(`/api/conversations/${conversationId}/activate`, "POST", { modelProfileId });
    assert.equal(ok.status, 200);

    discovered = [];
    await runtime.models.refreshAll();
    const secondConversation = await json("/api/conversations", "POST", {
      workspaceKey: persistent.state.workspaceKey,
    });
    const secondId = secondConversation.body.conversation.conversationId;
    const rejected = await json(`/api/conversations/${secondId}/activate`, "POST", { modelProfileId });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "MODEL_PROFILE_UNAVAILABLE");
  } finally {
    server.close();
    await once(server, "close");
    await persistent.close();
    await rm(root, { recursive: true, force: true });
  }
});
