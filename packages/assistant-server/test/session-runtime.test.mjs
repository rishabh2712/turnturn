import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completed, MemoryLiveSink, MemoryToolExecutor, StaticPolicy } from "@turnturn/assistant-core/testing";
import { CommandTypes, formatCommandId, formatTurnId, SCHEMA_VERSION } from "@turnturn/protocol";
import { reduceEngineState } from "@turnturn/protocol/engine-state";
import { ProviderHistoryItemTypes, reduceProviderHistory } from "@turnturn/protocol/provider-history";
import { readTraceBundle, reduceTraceBundle, traceRootForSessionLog } from "../dist/observability/index.js";
import { SessionRuntimeRegistry } from "../dist/session-runtime.js";
import { ConversationStore } from "../dist/storage/conversation-store.js";
import { openStateDirectory } from "../dist/storage/state-dir.js";

test("two session runtimes append independently and return only their own records", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = await openStateDirectory({ workspace, stateRoot: join(root, "state") });
  try {
    const store = await ConversationStore.open(state, { provider: "scripted", model: "model" });
    const first = await store.create();
    const second = await store.create();
    const firstSession = await store.activate(first.conversationId);
    const secondSession = await store.activate(second.conversationId);
    const registry = new SessionRuntimeRegistry({
      store,
      provider: {
        name: "scripted",
        async *run() {
          yield { type: "text-delta", text: "answer" };
          yield { type: "completed", reason: "complete" };
        },
      },
      tools: new MemoryToolExecutor(() => completed("unused")),
      policy: new StaticPolicy(),
      live: new MemoryLiveSink(),
    });

    const [firstOutcome, secondOutcome] = await Promise.all([
      registry.submit(command(first.conversationId, firstSession.sessionId, "first")),
      registry.submit(command(second.conversationId, secondSession.sessionId, "second")),
    ]);
    const firstRuntime = await registry.open(first.conversationId, firstSession.sessionId);
    const secondRuntime = await registry.open(second.conversationId, secondSession.sessionId);
    assert.equal(firstOutcome.kind, "accepted");
    assert.equal(secondOutcome.kind, "accepted");
    assert.ok(firstOutcome.records.every((record) => record.sessionId === firstSession.sessionId));
    assert.ok(secondOutcome.records.every((record) => record.sessionId === secondSession.sessionId));
    for (const runtime of [firstRuntime, secondRuntime]) {
      assert.deepEqual(
        runtime.durable.records().map((record) => record.sequence),
        Array.from({ length: runtime.durable.records().length }, (_, index) => index + 1),
      );
      assert.deepEqual(reduceEngineState(runtime.durable.records()).issues, []);
    }
    assert.equal(
      firstRuntime.durable.records().find((record) => record.type === "user.input.accepted").payload.text,
      "first",
    );
    assert.equal(
      secondRuntime.durable.records().find((record) => record.type === "user.input.accepted").payload.text,
      "second",
    );
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the registry does not evict a session with an active turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = await openStateDirectory({ workspace, stateRoot: join(root, "state") });
  try {
    const store = await ConversationStore.open(state, { provider: "scripted", model: "model" });
    const first = await store.create();
    const second = await store.create();
    const firstSession = await store.activate(first.conversationId);
    const secondSession = await store.activate(second.conversationId);
    let enterProvider;
    const entered = new Promise((resolve) => {
      enterProvider = resolve;
    });
    let releaseProvider;
    const release = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const registry = new SessionRuntimeRegistry({
      store,
      maxOpen: 1,
      provider: {
        name: "scripted",
        async *run() {
          enterProvider();
          await release;
          yield { type: "completed", reason: "complete" };
        },
      },
      tools: new MemoryToolExecutor(() => completed("unused")),
      policy: new StaticPolicy(),
      live: new MemoryLiveSink(),
    });
    const running = registry.submit(command(first.conversationId, firstSession.sessionId, "wait"));
    await entered;
    const active = await registry.open(first.conversationId, firstSession.sessionId);
    await registry.open(second.conversationId, secondSession.sessionId);
    assert.equal(await registry.open(first.conversationId, firstSession.sessionId), active);
    releaseProvider();
    await running;
    registry.sweep(Date.now() + 11 * 60_000);
    assert.equal(registry.size(), 0);
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reopened session includes its earlier turn in the next provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = await openStateDirectory({ workspace, stateRoot: join(root, "state") });
  try {
    const store = await ConversationStore.open(state, { provider: "scripted", model: "model" });
    const conversation = await store.create();
    const session = await store.activate(conversation.conversationId);
    const providerHistories = [];
    const options = {
      store,
      provider: {
        name: "scripted",
        async *run(request) {
          providerHistories.push(request.history);
          yield { type: "text-delta", text: "answer" };
          yield { type: "completed", reason: "complete" };
        },
      },
      tools: new MemoryToolExecutor(() => completed("unused")),
      policy: new StaticPolicy(),
      live: new MemoryLiveSink(),
    };
    const firstProcess = new SessionRuntimeRegistry(options);
    await firstProcess.submit(command(conversation.conversationId, session.sessionId, "first question"));
    const secondProcess = new SessionRuntimeRegistry(options);
    await secondProcess.submit(command(conversation.conversationId, session.sessionId, "second question"));

    assert.deepEqual(
      providerHistories[1].items
        .filter((item) => item.type === ProviderHistoryItemTypes.UserInput)
        .map((item) => item.content),
      ["first question", "second question"],
    );
    const reopened = await secondProcess.open(conversation.conversationId, session.sessionId);
    assert.deepEqual(reduceEngineState(reopened.durable.records()).issues, []);
    assert.deepEqual(reduceProviderHistory(reopened.durable.records()).issues, []);
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a traced provider step preserves model context and every concrete attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnturn-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = await openStateDirectory({ workspace, stateRoot: join(root, "state") });
  try {
    const store = await ConversationStore.open(state, { provider: "scripted", model: "model" });
    const conversation = await store.create();
    const session = await store.activate(conversation.conversationId);
    const degraded = [];
    const registry = new SessionRuntimeRegistry({
      store,
      provider: {
        name: "scripted",
        async *run(request, stepObservation) {
          const first = stepObservation.startProviderAttempt({ provider: "scripted", model: "model" });
          first.wireRequest({ method: "POST", route: "/first", body: { attempt: 1, history: request.history.items } });
          first.responseMetadata({ status: 503, upstreamRequestId: "upstream-first" });
          first.fail({ kind: "transport", message: "retryable outage", retryable: true });

          const second = stepObservation.startProviderAttempt({ provider: "scripted", model: "model" });
          second.wireRequest({
            method: "POST",
            route: "/second",
            body: { attempt: 2, history: request.history.items },
          });
          second.responseMetadata({ status: 200, upstreamRequestId: "upstream-second" });
          second.complete({ reason: "complete", durationMs: 12, upstreamRequestId: "upstream-second" });
          yield { type: "completed", reason: "complete" };
        },
      },
      tools: new MemoryToolExecutor(() => completed("unused")),
      policy: new StaticPolicy(),
      live: new MemoryLiveSink(),
      trace: { enabled: true, onDegraded: (failure) => degraded.push(failure) },
    });

    const outcome = await registry.submit(command(conversation.conversationId, session.sessionId, "trace me"));
    assert.equal(outcome.kind, "accepted");
    assert.deepEqual(degraded, []);
    const runtime = await registry.open(conversation.conversationId, session.sessionId);
    assert.deepEqual(reduceEngineState(runtime.durable.records()).issues, []);
    assert.deepEqual(reduceProviderHistory(runtime.durable.records()).issues, []);

    const sessionLog = store.sessionPath(conversation.conversationId, session.sessionId);
    const tracesRoot = traceRootForSessionLog(sessionLog);
    const traceIds = await readdir(tracesRoot);
    assert.equal(traceIds.length, 1);
    const bundle = await readTraceBundle(join(tracesRoot, traceIds[0]));
    const reduced = reduceTraceBundle(bundle);

    assert.deepEqual(bundle.issues, []);
    assert.deepEqual(
      reduced.attempts.map((attempt) => attempt.status),
      ["failed", "completed"],
    );
    assert.equal(new Set(reduced.attempts.map((attempt) => attempt.attemptId)).size, 2);
    assert.equal(reduced.steps[0].status, "completed");
    assert.equal(reduced.turns[0].status, "completed");

    const contextEnvelope = bundle.envelopes.find((envelope) => envelope.type === "step.model-context");
    assert.ok(contextEnvelope?.payloadRef);
    const context = JSON.parse(
      await readFile(join(bundle.bundlePath, "payloads", `${contextEnvelope.payloadRef}.json`), "utf8"),
    );
    assert.deepEqual(
      context.catalog.contributions.map((contribution) => contribution.kind),
      ["conversation-history", "tool-definitions"],
    );

    const requestEnvelopes = bundle.envelopes.filter((envelope) => envelope.type === "attempt.wire-request");
    assert.equal(requestEnvelopes.length, 2);
    const requestBodies = await Promise.all(
      requestEnvelopes.map((envelope) =>
        readFile(join(bundle.bundlePath, "payloads", `${envelope.payloadRef}.json`), "utf8").then(JSON.parse),
      ),
    );
    assert.deepEqual(
      requestBodies.map((body) => body.attempt),
      [1, 2],
    );
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

function command(conversationId, sessionId, input) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: formatCommandId(randomUUID()),
    type: CommandTypes.TurnSubmit,
    createdAt: new Date().toISOString(),
    conversationId,
    sessionId,
    turnId: formatTurnId(randomUUID()),
    payload: { input },
  };
}
