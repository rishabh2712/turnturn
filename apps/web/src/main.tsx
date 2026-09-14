import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBrowserTransport } from "./browser-transport";
import { TransportProvider } from "./providers/TransportProvider";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <TransportProvider transport={createBrowserTransport()}>
      <App />
    </TransportProvider>
  </StrictMode>,
);
