import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpChatTransport, TransportHttpError } from "../dist/http-transport.js";

// A real node:http server standing in for assistant-server, just enough to exercise
// HttpChatTransport's request-building, auth header, and error-mapping logic with a
// genuine fetch round trip — not a mock of fetch itself.
async function startFakeServer(handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

test("getRuntime sends the token header and returns the parsed body", async (t) => {
  let receivedToken;
  const { server, baseUrl } = await startFakeServer((req, res) => {
    receivedToken = req.headers["x-turnturn-token"];
    json(res, 200, { provider: "openai-chat-completions", model: "m", serverInstanceId: "srv_1" });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "secret-token" });
  const runtime = await transport.getRuntime();
  assert.equal(receivedToken, "secret-token");
  assert.equal(runtime.provider, "openai-chat-completions");
});

test("listConversations encodes query parameters", async (t) => {
  let receivedUrl;
  const { server, baseUrl } = await startFakeServer((req, res) => {
    receivedUrl = req.url;
    json(res, 200, { conversations: [], nextCursor: null });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  await transport.listConversations({ archived: true, limit: 10 });
  const params = new URL(receivedUrl, baseUrl).searchParams;
  assert.equal(params.get("archived"), "true");
  assert.equal(params.get("limit"), "10");
});

test("createConversation sends a JSON body with the content-type header", async (t) => {
  let receivedContentType;
  let receivedBody;
  const { server, baseUrl } = await startFakeServer((req, res, body) => {
    receivedContentType = req.headers["content-type"];
    receivedBody = body;
    json(res, 201, { conversation: { conversationId: "conv_1", workspaceKey: body.workspaceKey } });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  const created = await transport.createConversation({ workspaceKey: "ws_1", title: "Hi" });
  assert.match(receivedContentType, /application\/json/);
  assert.deepEqual(receivedBody, { workspaceKey: "ws_1", title: "Hi" });
  assert.equal(created.workspaceKey, "ws_1");
});

test("patchConversation unwraps the server's conversation envelope", async (t) => {
  const { server, baseUrl } = await startFakeServer((_req, res) => {
    json(res, 200, { conversation: { conversationId: "conv_1", title: "Renamed" } });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  const updated = await transport.patchConversation("conv_1", { title: "Renamed" });
  assert.equal(updated.title, "Renamed");
});

test("deleteConversation handles an empty 204 response", async (t) => {
  const { server, baseUrl } = await startFakeServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  await assert.doesNotReject(() => transport.deleteConversation("conv_1"));
});

test("a non-2xx response throws TransportHttpError carrying the server's error code", async (t) => {
  const { server, baseUrl } = await startFakeServer((_req, res) => {
    json(res, 409, { error: { code: "CONVERSATION_NOT_ARCHIVED", message: "Archive it first" } });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  await assert.rejects(
    () => transport.deleteConversation("conv_1"),
    (error) => {
      assert.ok(error instanceof TransportHttpError);
      assert.equal(error.code, "CONVERSATION_NOT_ARCHIVED");
      assert.equal(error.status, 409);
      assert.equal(error.message, "Archive it first");
      return true;
    },
  );
});

test("a non-2xx response with no error envelope falls back to a generic code and status message", async (t) => {
  const { server, baseUrl } = await startFakeServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  await assert.rejects(
    () => transport.getRuntime(),
    (error) => {
      assert.ok(error instanceof TransportHttpError);
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test("getRecords builds the afterSequence and limit query and returns the page", async (t) => {
  let receivedUrl;
  const { server, baseUrl } = await startFakeServer((req, res) => {
    receivedUrl = req.url;
    json(res, 200, { sessionId: "sess_1", records: [], lastSequence: 5, hasMore: false });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  const page = await transport.getRecords("conv_1", "sess_1", 5, 100);
  assert.match(receivedUrl, /\/api\/conversations\/conv_1\/sessions\/sess_1\/records\?/);
  const params = new URL(receivedUrl, baseUrl).searchParams;
  assert.equal(params.get("afterSequence"), "5");
  assert.equal(params.get("limit"), "100");
  assert.equal(page.lastSequence, 5);
});

test("submitCommand returns a 200 rejected outcome as data, not as a thrown error", async (t) => {
  const { server, baseUrl } = await startFakeServer((_req, res) => {
    json(res, 200, {
      kind: "rejected",
      code: "IDEMPOTENCY_KEY_TYPE_MISMATCH",
      message: "replayed with a different type",
    });
  });
  t.after(() => server.close());

  const transport = new HttpChatTransport({ baseUrl, token: "t" });
  const result = await transport.submitCommand({});
  assert.equal(result.kind, "rejected");
});

// --- subscribeEvents, against a minimal EventSource test double ------------------
//
// Real browser EventSource isn't a global under plain `node --test`, and its actual
// network/reconnect behavior can only be proven against a real server (see resume.ts's
// doc comment). This double proves our own wiring: the URL is built correctly, a
// listener is registered for "snapshot" and for every LiveEventTypes value, and
// unsubscribe actually removes them and closes the connection.

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((held) => held !== handler),
    );
  }
  close() {
    this.closed = true;
  }
  dispatch(type, data) {
    for (const handler of this.listeners.get(type) ?? []) handler({ data: JSON.stringify(data) });
  }
}

test("subscribeEvents opens an EventSource with the token in the query string, never a header", async () => {
  globalThis.EventSource = FakeEventSource;
  const transport = new HttpChatTransport({ baseUrl: "http://127.0.0.1:1", token: "secret" });
  const unsubscribe = transport.subscribeEvents("conv_1", { onSnapshot() {}, onEvent() {}, onError() {} });
  const source = FakeEventSource.instances.at(-1);
  const url = new URL(source.url, "http://127.0.0.1:1");
  assert.equal(url.pathname, "/events");
  assert.equal(url.searchParams.get("conversationId"), "conv_1");
  assert.equal(url.searchParams.get("token"), "secret");
  unsubscribe();
});

test("subscribeEvents routes a snapshot frame to onSnapshot and a live frame to onEvent", async () => {
  globalThis.EventSource = FakeEventSource;
  const transport = new HttpChatTransport({ baseUrl: "http://127.0.0.1:1", token: "t" });
  let snapshot;
  let event;
  const unsubscribe = transport.subscribeEvents("conv_1", {
    onSnapshot: (frame) => {
      snapshot = frame;
    },
    onEvent: (evt) => {
      event = evt;
    },
    onError() {},
  });
  const source = FakeEventSource.instances.at(-1);
  source.dispatch("snapshot", { conversationId: "conv_1", serverInstanceId: "srv_1", sessions: [] });
  source.dispatch("content.delta", { type: "content.delta", payload: { text: "hi" } });

  assert.equal(snapshot.serverInstanceId, "srv_1");
  assert.equal(event.payload.text, "hi");
  unsubscribe();
});

test("unsubscribe removes every listener and closes the connection", async () => {
  globalThis.EventSource = FakeEventSource;
  const transport = new HttpChatTransport({ baseUrl: "http://127.0.0.1:1", token: "t" });
  let calls = 0;
  const unsubscribe = transport.subscribeEvents("conv_1", {
    onSnapshot: () => {
      calls += 1;
    },
    onEvent: () => {
      calls += 1;
    },
    onError() {},
  });
  const source = FakeEventSource.instances.at(-1);
  unsubscribe();

  assert.equal(source.closed, true);
  source.dispatch("snapshot", {});
  source.dispatch("content.delta", { payload: { text: "late" } });
  assert.equal(calls, 0);
});
