// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatTransport } from "@turnturn/chat-client";
import { afterEach, expect, test } from "vitest";
import { TransportProvider, useChatTransport } from "../src/providers/TransportProvider";

afterEach(cleanup);

test("a child receives the injected chat transport", () => {
  const transport = {} as ChatTransport;
  function Probe() {
    return <output>{useChatTransport() === transport ? "injected" : "wrong transport"}</output>;
  }

  render(
    <TransportProvider transport={transport}>
      <Probe />
    </TransportProvider>,
  );

  expect(screen.getByText("injected").tagName).toBe("OUTPUT");
});
