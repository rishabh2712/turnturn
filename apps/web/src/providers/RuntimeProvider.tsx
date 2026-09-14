import type { RuntimeInfo } from "@turnturn/chat-client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useChatTransport } from "./TransportProvider";

type RuntimeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly runtime: RuntimeInfo }
  | { readonly status: "error"; readonly message: string };

const RuntimeContext = createContext<RuntimeState | null>(null);

export function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  const transport = useChatTransport();
  const [state, setState] = useState<RuntimeState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void transport.getRuntime().then(
      (runtime) => {
        if (active) setState({ status: "ready", runtime });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [transport]);

  return <RuntimeContext.Provider value={state}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeState {
  const state = useContext(RuntimeContext);
  if (state === null) throw new Error("RuntimeProvider is missing");
  return state;
}
