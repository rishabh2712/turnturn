import { HttpChatTransport } from "@turnturn/chat-client";

export function createBrowserTransport(): HttpChatTransport {
  const injected = (window as Window & { __TURNTURN__?: { token?: string } }).__TURNTURN__?.token;
  return new HttpChatTransport({ token: injected ?? import.meta.env.VITE_TURNTURN_TOKEN ?? "" });
}
