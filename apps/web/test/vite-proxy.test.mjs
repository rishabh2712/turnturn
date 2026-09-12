import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { test } from "vitest";

test("the dev server forwards API, command, and event requests to the assistant server", async () => {
  const backend = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendAddress = backend.address();
  assert(backendAddress && typeof backendAddress === "object");
  process.env.TURNTURN_SERVER_URL = `http://127.0.0.1:${backendAddress.port}`;

  let vite;
  try {
    vite = await createViteServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    for (const [path, method] of [
      ["/api/runtime", "GET"],
      ["/commands", "POST"],
      ["/events", "GET"],
    ]) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { method, path });
    }
  } finally {
    await vite?.close();
    backend.close();
    await once(backend, "close");
    delete process.env.TURNTURN_SERVER_URL;
  }
});
