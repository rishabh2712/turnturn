import { afterEach, expect, test, vi } from "vitest";
import { createBrowserTransport } from "../src/browser-transport";

afterEach(() => vi.unstubAllGlobals());

test("built client sends the server-injected token with commands", async () => {
  vi.stubGlobal("window", { __TURNTURN__: { token: "injected-token" } });
  const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ kind: "accepted" }) }));
  vi.stubGlobal("fetch", fetchMock);
  await createBrowserTransport().submitCommand(
    {} as Parameters<ReturnType<typeof createBrowserTransport>["submitCommand"]>[0],
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/commands",
    expect.objectContaining({ headers: expect.objectContaining({ "x-turnturn-token": "injected-token" }) }),
  );
});
