import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ollamaChatCompletions } from "../../../dist/providers/openai-chat-completions/index.js";

test("Ollama chat-completions adapter uses the OpenAI-compatible route without credentials", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          'data: {"choices":[{"index":0,"delta":{"content":"local"}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });

  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const adapter = ollamaChatCompletions({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "llama3.2",
    });

    const events = [];
    for await (const event of adapter.run(providerRequest())) events.push(event);

    assert.deepEqual(events, [
      { type: "text-delta", text: "local" },
      { type: "completed", reason: "complete" },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests[0].body.model, "llama3.2");
    assert.equal(requests[0].body.stream, true);
  } finally {
    await close(server);
  }
});

function providerRequest() {
  return {
    conversationId: "conv_018f1f4e-8d5f-7abc-8123-000000000001",
    sessionId: "sess_018f1f4e-8d5f-7abc-8123-000000000002",
    turnId: "turn_018f1f4e-8d5f-7abc-8123-000000000003",
    stepId: "step_018f1f4e-8d5f-7abc-8123-000000000004",
    history: { items: [], issues: [], lastSequence: 0 },
    signal: new AbortController().signal,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
