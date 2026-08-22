import { afterEach, describe, expect, it, vi } from "vitest";

import configFactory from "../vite.config";

afterEach(() => {
  delete process.env.TABHUB_DEV_PROXY_SECRET;
});

describe("Vite local-session proxy", () => {
  it("injects the root server-only secret only into the bootstrap request", async () => {
    const secret = "SERVER_ONLY_PROXY_CANARY";
    process.env.TABHUB_DEV_PROXY_SECRET = secret;
    const config = await (configFactory as Function)({ command: "serve", mode: "test" });
    const proxyConfig = config.server.proxy["/api"];
    let onProxyRequest: ((proxyRequest: { setHeader: Function }, request: { method?: string; url?: string }) => void) | undefined;
    proxyConfig.configure({
      on(event: string, listener: typeof onProxyRequest) {
        if (event === "proxyReq") onProxyRequest = listener;
      },
    });
    const setHeader = vi.fn();

    onProxyRequest?.(
      { setHeader },
      { method: "POST", url: "/api/local/session/bootstrap" },
    );
    expect(setHeader).toHaveBeenCalledWith("x-tabhub-dev-proxy-secret", secret);

    setHeader.mockClear();
    onProxyRequest?.({ setHeader }, { method: "POST", url: "/api/local/pages/41/context/commands" });
    expect(setHeader).not.toHaveBeenCalled();
    expect(config.define).toBeUndefined();
  });
});
