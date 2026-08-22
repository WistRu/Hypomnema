import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const serverEnvironment = loadEnv(mode, workspaceRoot, "");
  const devProxySecret = serverEnvironment.TABHUB_DEV_PROXY_SECRET?.trim();

  return {
    base: "/app/",
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: "http://127.0.0.1:7717",
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest, request) => {
              if (
                devProxySecret &&
                request.method === "POST" &&
                request.url?.split("?", 1)[0] === "/api/local/session/bootstrap"
              ) {
                proxyRequest.setHeader(
                  "x-tabhub-dev-proxy-secret",
                  devProxySecret,
                );
              }
            });
          },
        },
      },
    },
  };
});
