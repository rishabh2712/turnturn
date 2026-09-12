import { defineConfig } from "vite";

const backend = process.env.TURNTURN_SERVER_URL ?? "http://127.0.0.1:8787";
const proxy = {
  target: backend,
  changeOrigin: true,
  configure(proxyServer: {
    on: (event: string, callback: (proxyReq: { setHeader: (name: string, value: string) => void }) => void) => void;
  }) {
    proxyServer.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", backend));
  },
};

export default defineConfig({
  server: {
    proxy: {
      "/api": proxy,
      "/commands": proxy,
      "/events": proxy,
      "/records": proxy,
      "/debug": proxy,
    },
  },
});
