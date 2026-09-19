import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completed, MemoryLiveSink, MemoryToolExecutor, StaticPolicy } from "@turnturn/assistant-core/testing";
import { CommandTypes, formatCommandId, formatTurnId, SCHEMA_VERSION } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { ModelCatalog } from "../dist/model-catalog.js";
import { SessionRuntimeRegistry } from "../dist/session-runtime.js";
import { ConversationStore } from "../dist/storage/conversation-store.js";
import { openStateDirectory } from "../dist/storage/state-dir.js";

function turnSubmitCommand(conversationId, sessionId, text) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: formatCommandId(crypto.randomUUID()),
    type: CommandTypes.TurnSubmit,
    createdAt: new Date().toISOString(),
    conversationId,
    sessionId,
    turnId: formatTurnId(crypto.randomUUID()),
    payload: { input: text },
  };
}

test("a turn against a model no longer in the discovery catalog is rejected before the provider is ever invoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-availability-test-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const state = await openStateDirectory({ workspace, stateRoot: join(root, "state") });

    let discovered = [{ modelId: "vanishing", label: "Vanishing", toolCompatibility: "unknown" }];
    const models = new ModelCatalog(
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
    await models.refreshAll();
    const snapshot = models.providerSnapshot();
    const modelProfileId = snapshot.connections[0].models.find((m) => m.model === "vanishing").id;

    const store = await ConversationStore.open(state, { provider: "ollama", model: "keep", modelProfileId: "default" });
    const conversation = await store.create();
    const session = await store.activate(conversation.conversationId, {
      provider: "ollama",
      model: "vanishing",
      modelProfileId,
    });

    let providerInvocations = 0;
    const registry = new SessionRuntimeRegistry({
      store,
      provider: {
        name: "should-not-be-called",
        async *run() {
          providerInvocations += 1;
          yield { type: "completed", reason: "complete" };
        },
      },
      providerForSession: () => ({
        name: "should-not-be-called-either",
        async *run() {
          providerInvocations += 1;
          yield { type: "completed", reason: "complete" };
        },
      }),
      models,
      tools: new MemoryToolExecutor(() => completed("unused")),
      policy: new StaticPolicy(),
      live: new MemoryLiveSink(),
    });

    // The model is discoverable right now: opening the session and reading it works,
    // and (if we let it run) the provider would be reachable.
    assert.equal(models.isAvailable(modelProfileId), true);

    // Now the model disappears from the live discovery snapshot (a restart, or the
    // provider no longer lists it) while the conversation itself is untouched.
    discovered = [];
    await models.refreshAll();
    assert.equal(models.isAvailable(modelProfileId), false);

    // Reading the conversation and its (still empty) records keeps working.
    const reopened = await registry.open(conversation.conversationId, session.sessionId);
    assert.equal(reopened.sessionId, session.sessionId);

    const outcome = await registry.submit(turnSubmitCommand(conversation.conversationId, session.sessionId, "hello"));
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.code, "MODEL_PROFILE_UNAVAILABLE");
    assert.equal(providerInvocations, 0, "the provider must never be invoked for an unavailable model");

    // No turn-related records were appended — only the session's bootstrap records exist.
    const records = reopened.durable.records();
    assert.ok(!records.some((record) => record.type.startsWith("turn.")));
    assert.deepEqual(reduceEngineState(records).issues, []);
    assert.deepEqual(reduceProviderHistory(records).issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
