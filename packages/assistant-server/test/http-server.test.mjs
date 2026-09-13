import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CommandTypes,
  formatCommandId,
  formatConversationId,
  formatSessionId,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import { createAssistantHttpServer, createAssistantRuntime } from "../dist/index.js";

test("POST /commands round-trips commands while global /records is absent", async () => {
  const harness = await startHarness();
  try {
    const conversationId = formatConversationId(randomUUID());
    const sessionId = formatSessionId(randomUUID());
    const response = await postJson(
      harness.url("/commands"),
      command(CommandTypes.ConversationCreate, { conversationId, sessionId }, { title: "server test" }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.kind, "accepted");
    assert.equal(response.body.records.length, 1);

    const session = await postJson(
      harness.url("/commands"),
      command(CommandTypes.SessionCreate, { conversationId, sessionId }, { provider: "test" }),
    );
    assert.equal(session.status, 200);
    assert.equal(session.body.kind, "accepted");

    assert.equal((await getJson(harness.url("/records?afterSequence=0"))).status, 404);
  } finally {
    await harness.close();
  }
});

test("GET /events sends a snapshot frame and never emits SSE id fields", async () => {
  const harness = await startHarness();
  try {
    const stream = await openStream(harness.url("/events?token=test-token"));
    try {
      assert.equal(stream.headers["x-turnturn-last-sequence"], undefined);
      const chunk = await stream.nextChunk();
      assert.match(chunk, /^event: snapshot\n/m);
      assert.match(chunk, /"snapshotSequence":0/);
      assert.doesNotMatch(chunk, /^id:/m);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("GET /debug/state exposes reducer issues for the durable log", async () => {
  const harness = await startHarness();
  try {
    const response = await getJson(harness.url("/debug/state"));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.issues, []);
    assert.equal(response.body.lastSequence, 0);
  } finally {
    await harness.close();
  }
});

test("POST /commands rejects malformed JSON", async () => {
  const harness = await startHarness();
  try {
    const response = await postRaw(harness.url("/commands"), "{");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_JSON");
  } finally {
    await harness.close();
  }
});

test("host, origin, and token checks refuse requests before reaching the engine", async () => {
  const harness = await startHarness();
  try {
    const conversationId = formatConversationId(randomUUID());
    const sessionId = formatSessionId(randomUUID());
    const body = JSON.stringify(
      command(CommandTypes.ConversationCreate, { conversationId, sessionId }, { title: "blocked" }),
    );
    for (const [headers, status, code] of [
      [{ "x-turnturn-token": "test-token", origin: "http://evil.example" }, 403, "INVALID_ORIGIN"],
      [{ "x-turnturn-token": "test-token", host: "evil.example" }, 403, "INVALID_HOST"],
      [{}, 401, "INVALID_TOKEN"],
    ]) {
      const response = await rawRequest(harness.url("/commands"), headers, body);
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, code);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    assert.equal((await getJson(harness.url("/records"))).status, 404);
  } finally {
    await harness.close();
  }
});

test("served HTML receives the process token while other responses do not expose it", async () => {
  const staticDir = await mkdtemp(join(tmpdir(), "turnturn-static-test-"));
  await writeFile(join(staticDir, "index.html"), "<html><head></head><body>app</body></html>");
  const harness = await startHarness({ staticDir });
  try {
    const page = await fetch(harness.url("/"));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /window\.__TURNTURN__=\{token:"test-token"\}/);
    const debug = await getJson(harness.url("/debug/state"));
    assert.doesNotMatch(JSON.stringify(debug.body), /test-token/);
  } finally {
    await harness.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("a non-reading event subscriber does not block command completion", async () => {
  const harness = await startHarness();
  try {
    const stream = await openStream(harness.url("/events?token=test-token"), { pause: true });
    try {
      const conversationId = formatConversationId(randomUUID());
      const sessionId = formatSessionId(randomUUID());
      const response = await postJson(
        harness.url("/commands"),
        command(CommandTypes.ConversationCreate, { conversationId, sessionId }, { title: "blocked subscriber" }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.kind, "accepted");
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

async function startHarness(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "turnturn-server-test-"));
  const runtime = createAssistantRuntime({ workspace, provider: "ollama", model: "test-model" });
  const server = createAssistantHttpServer({ runtime, token: "test-token", ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function command(type, scope, payload) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: formatCommandId(randomUUID()),
    type,
    createdAt: new Date().toISOString(),
    ...scope,
    payload,
  };
}

async function postJson(url, body) {
  return await postRaw(url, JSON.stringify(body));
}

async function postRaw(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-turnturn-token": "test-token" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "x-turnturn-token": "test-token" } });
  return { status: response.status, body: await response.json() };
}

async function openStream(url, options = {}) {
  const request = get(url, { headers: { "x-turnturn-token": "test-token" } });
  const [response] = await once(request, "response");
  if (options.pause) response.pause();
  return {
    headers: response.headers,
    nextChunk: async () => {
      const [chunk] = await once(response, "data");
      return chunk.toString("utf8");
    },
    close: () => {
      request.destroy();
    },
  };
}

async function rawRequest(url, headers, body) {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}
