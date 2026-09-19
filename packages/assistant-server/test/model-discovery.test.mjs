import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { discoverAnthropicModels, parseAnthropicModelsPage } from "../dist/model-discovery/anthropic.js";
import { discoverLiteLlmModels, parseLiteLlmModelsResponse } from "../dist/model-discovery/litellm.js";
import {
  discoverOllamaModels,
  parseOllamaShowResponse,
  parseOllamaTagsResponse,
} from "../dist/model-discovery/ollama.js";

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// --- Anthropic -------------------------------------------------------------

test("parseAnthropicModelsPage rejects an unexpected shape", () => {
  assert.throws(() => parseAnthropicModelsPage({}));
  assert.throws(() => parseAnthropicModelsPage({ data: [{ id: 5 }] }));
  assert.throws(() => parseAnthropicModelsPage(null));
});

test("Anthropic discovery follows pagination and de-duplicates ids", async () => {
  let calls = 0;
  await withServer(
    (req, res) => {
      calls += 1;
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("after_id") === null) {
        sendJson(res, 200, {
          data: [
            { id: "claude-a", display_name: "Claude A" },
            { id: "claude-a", display_name: "Claude A dup" },
          ],
          has_more: true,
          last_id: "claude-a",
        });
      } else {
        sendJson(res, 200, { data: [{ id: "claude-b" }], has_more: false });
      }
    },
    async (baseUrl) => {
      const outcome = await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" });
      assert.equal(outcome.status, "ok");
      assert.equal(calls, 2);
      assert.deepEqual(outcome.models.map((m) => m.modelId).sort(), ["claude-a", "claude-b"]);
      assert.ok(outcome.models.every((m) => m.toolCompatibility === "supported"));
    },
  );
});

test("Anthropic discovery maps 401/403/5xx to fixed error codes without exposing the body", async () => {
  await withServer(
    (_req, res) => sendJson(res, 401, { error: { message: "sk-super-secret leaked here" } }),
    async (baseUrl) => {
      const outcome = await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" });
      assert.deepEqual(outcome, { status: "error", code: "UNAUTHORIZED" });
    },
  );
  await withServer(
    (_req, res) => sendJson(res, 403, {}),
    async (baseUrl) => {
      assert.deepEqual(await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" }), {
        status: "error",
        code: "FORBIDDEN",
      });
    },
  );
  await withServer(
    (_req, res) => sendJson(res, 500, {}),
    async (baseUrl) => {
      assert.deepEqual(await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" }), {
        status: "error",
        code: "SERVER_ERROR",
      });
    },
  );
});

test("Anthropic discovery reports malformed JSON and unexpected shape distinctly", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    },
    async (baseUrl) => {
      assert.deepEqual(await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" }), {
        status: "error",
        code: "MALFORMED_RESPONSE",
      });
    },
  );
  await withServer(
    (_req, res) => sendJson(res, 200, { unexpected: true }),
    async (baseUrl) => {
      assert.deepEqual(await discoverAnthropicModels({ baseUrl, apiKey: "sk-test" }), {
        status: "error",
        code: "UNEXPECTED_SHAPE",
      });
    },
  );
});

test("Anthropic discovery reports a bounded timeout distinct from an external abort", async () => {
  await withServer(
    (_req, res) => {
      setTimeout(() => sendJson(res, 200, { data: [] }), 200);
    },
    async (baseUrl) => {
      const outcome = await discoverAnthropicModels({ baseUrl, apiKey: "sk-test", timeoutMs: 20 });
      assert.deepEqual(outcome, { status: "error", code: "TIMEOUT" });
    },
  );
  await withServer(
    (_req, res) => {
      setTimeout(() => sendJson(res, 200, { data: [] }), 200);
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const pending = discoverAnthropicModels({ baseUrl, apiKey: "sk-test", signal: controller.signal });
      controller.abort();
      assert.deepEqual(await pending, { status: "error", code: "ABORTED" });
    },
  );
});

test("Anthropic discovery reports a network error when the connection is refused", async () => {
  const outcome = await discoverAnthropicModels({ baseUrl: "http://127.0.0.1:1", apiKey: "sk-test", timeoutMs: 500 });
  assert.equal(outcome.status, "error");
  assert.ok(["NETWORK_ERROR", "TIMEOUT"].includes(outcome.code));
});

// --- LiteLLM -----------------------------------------------------------------

test("parseLiteLlmModelsResponse marks every entry unknown, never inferring from the model name", () => {
  const models = parseLiteLlmModelsResponse({ data: [{ id: "bedrock-claude-5-sonnet" }, { id: "gpt-4o" }] });
  assert.ok(models.every((m) => m.toolCompatibility === "unknown"));
});

test("LiteLLM discovery de-duplicates ids and requires the data array shape", async () => {
  assert.throws(() => parseLiteLlmModelsResponse({}));
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, "Bearer litellm-secret");
      sendJson(res, 200, { data: [{ id: "m1" }, { id: "m1" }, { id: "m2" }] });
    },
    async (baseUrl) => {
      const outcome = await discoverLiteLlmModels({ baseUrl, apiKey: "litellm-secret" });
      assert.equal(outcome.status, "ok");
      assert.deepEqual(outcome.models.map((m) => m.modelId).sort(), ["m1", "m2"]);
    },
  );
});

test("LiteLLM discovery maps auth and server failures to fixed codes", async () => {
  await withServer(
    (_req, res) => sendJson(res, 403, {}),
    async (baseUrl) => {
      assert.deepEqual(await discoverLiteLlmModels({ baseUrl }), { status: "error", code: "FORBIDDEN" });
    },
  );
  await withServer(
    (_req, res) => sendJson(res, 503, {}),
    async (baseUrl) => {
      assert.deepEqual(await discoverLiteLlmModels({ baseUrl }), { status: "error", code: "SERVER_ERROR" });
    },
  );
});

// --- Ollama --------------------------------------------------------------

test("parseOllamaTagsResponse and parseOllamaShowResponse classify capabilities", () => {
  assert.deepEqual(parseOllamaTagsResponse({ models: [{ model: "llama3" }, { name: "qwen3" }] }), ["llama3", "qwen3"]);
  assert.throws(() => parseOllamaTagsResponse({}));
  assert.deepEqual(parseOllamaShowResponse({ capabilities: ["completion", "tools"] }), {
    selectable: true,
    toolCompatibility: "supported",
  });
  assert.deepEqual(parseOllamaShowResponse({ capabilities: ["completion"] }), {
    selectable: true,
    toolCompatibility: "unknown",
  });
  assert.deepEqual(parseOllamaShowResponse({ capabilities: ["embedding"] }), {
    selectable: false,
    toolCompatibility: "unsupported",
  });
  assert.deepEqual(parseOllamaShowResponse({}), { selectable: true, toolCompatibility: "unknown" });
});

test("Ollama discovery lists installed models and checks capabilities per model", async () => {
  await withServer(
    (req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        sendJson(res, 200, { models: [{ model: "llama3" }, { model: "embedder" }] });
        return;
      }
      if (req.method === "POST" && req.url === "/api/show") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const { model } = JSON.parse(body);
          if (model === "llama3") sendJson(res, 200, { capabilities: ["completion", "tools"] });
          else sendJson(res, 200, { capabilities: ["embedding"] });
        });
        return;
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const outcome = await discoverOllamaModels({ baseUrl });
      assert.equal(outcome.status, "ok");
      const llama = outcome.models.find((m) => m.modelId === "llama3");
      const embedder = outcome.models.find((m) => m.modelId === "embedder");
      assert.equal(llama.toolCompatibility, "supported");
      assert.equal(embedder.toolCompatibility, "unsupported");
    },
  );
});

test("Ollama discovery degrades a single failing capability check to unknown rather than failing outright", async () => {
  await withServer(
    (req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        sendJson(res, 200, { models: [{ model: "flaky" }] });
        return;
      }
      res.writeHead(500).end();
    },
    async (baseUrl) => {
      const outcome = await discoverOllamaModels({ baseUrl });
      assert.equal(outcome.status, "ok");
      assert.deepEqual(outcome.models, [{ modelId: "flaky", label: "flaky", toolCompatibility: "unknown" }]);
    },
  );
});

test("Ollama discovery reports server and malformed-shape errors for /api/tags itself", async () => {
  await withServer(
    (_req, res) => sendJson(res, 500, {}),
    async (baseUrl) => {
      assert.deepEqual(await discoverOllamaModels({ baseUrl }), { status: "error", code: "SERVER_ERROR" });
    },
  );
  await withServer(
    (_req, res) => sendJson(res, 200, { models: "not-an-array" }),
    async (baseUrl) => {
      assert.deepEqual(await discoverOllamaModels({ baseUrl }), { status: "error", code: "UNEXPECTED_SHAPE" });
    },
  );
});
