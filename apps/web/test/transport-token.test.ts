import { afterEach, expect, test, vi } from "vitest";
import { sendCommand } from "../src/transport";

afterEach(() => vi.unstubAllGlobals());

test("built client sends the server-injected token with commands", async () => {
  vi.stubGlobal("window", { __TURNTURN__: { token: "injected-token" } });
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ kind: "accepted" }) }));
  vi.stubGlobal("fetch", fetchMock);
  await sendCommand({} as Parameters<typeof sendCommand>[0]);
  expect(fetchMock).toHaveBeenCalledWith(
    "/commands",
    expect.objectContaining({ headers: expect.objectContaining({ "x-turnturn-token": "injected-token" }) }),
  );
});
