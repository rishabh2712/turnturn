import type { ChatTransport } from "@turnturn/chat-client";
import { createContext, type ReactNode, useContext } from "react";

const TransportContext = createContext<ChatTransport | null>(null);

export function TransportProvider({
  transport,
  children,
}: {
  readonly transport: ChatTransport;
  readonly children: ReactNode;
}) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

export function useChatTransport(): ChatTransport {
  const transport = useContext(TransportContext);
  if (transport === null) throw new Error("TransportProvider is missing");
  return transport;
}
