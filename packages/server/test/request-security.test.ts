import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  isAllowedBrowserOrigin,
  isAllowedLocalHostHeader,
} from "../src/request-security.js";

function requestStatus(origin: string, host: string): Promise<number> {
  const url = new URL("/api/health", origin);

  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: { host },
        hostname: url.hostname,
        method: "GET",
        path: url.pathname,
        port: url.port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("local request boundary", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:7717",
    "localhost",
    "LOCALHOST:65535",
  ])("accepts local Host authority %s", (host) => {
    expect(isAllowedLocalHostHeader(host)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "attacker.example:7717",
    "127.0.0.1.attacker.example",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:7717/path",
    "user@127.0.0.1:7717",
  ])("rejects untrusted or malformed Host authority %s", (host) => {
    expect(isAllowedLocalHostHeader(host)).toBe(false);
  });

  it("accepts only local web and Chromium extension browser origins", () => {
    expect(isAllowedBrowserOrigin("http://127.0.0.1:7717")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:7717")).toBe(true);
    expect(isAllowedBrowserOrigin("chrome-extension://abcdefghijklmnop")).toBe(
      true,
    );
    expect(isAllowedBrowserOrigin("https://attacker.example")).toBe(false);
    expect(isAllowedBrowserOrigin("http://127.0.0.1.attacker.example")).toBe(
      false,
    );
  });

  it("allows top-level app navigation while rejecting unsafe browser requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-security-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    app.get("/app/", async () => ({ status: "app" }));

    try {
      const rebinding = await app.inject({
        headers: {
          host: "attacker.example:7717",
          origin: "http://attacker.example:7717",
        },
        method: "GET",
        url: "/api/health",
      });
      expect(rebinding.statusCode).toBe(421);
      expect(rebinding.json()).toEqual({ error: "UNTRUSTED_HOST" });

      const hostileOrigin = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "GET",
        url: "/api/tabs?search_mode=semantic&q=trigger",
      });
      expect(hostileOrigin.statusCode).toBe(403);
      expect(hostileOrigin.json()).toEqual({ error: "UNTRUSTED_ORIGIN" });

      const crossSiteNavigation = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
        },
        method: "GET",
        url: "/app/",
      });
      expect(crossSiteNavigation.statusCode).toBe(200);
      expect(crossSiteNavigation.json()).toEqual({ status: "app" });
      expect(crossSiteNavigation.headers["x-frame-options"]).toBe("DENY");
      expect(crossSiteNavigation.headers["content-security-policy"]).toBe(
        "frame-ancestors 'none'",
      );

      const crossSiteApiRequest = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
        },
        method: "GET",
        url: "/api/health",
      });
      expect(crossSiteApiRequest.statusCode).toBe(403);
      expect(crossSiteApiRequest.json()).toEqual({
        error: "CROSS_SITE_REQUEST_BLOCKED",
      });

      const crossSiteFrame = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          "sec-fetch-dest": "iframe",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
        },
        method: "GET",
        url: "/app/",
      });
      expect(crossSiteFrame.statusCode).toBe(403);
      expect(crossSiteFrame.json()).toEqual({
        error: "CROSS_SITE_REQUEST_BLOCKED",
      });

      const extension = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          origin: "chrome-extension://abcdefghijklmnop",
          "sec-fetch-site": "cross-site",
        },
        method: "GET",
        url: "/api/health",
      });
      expect(extension.statusCode).toBe(200);
      expect(extension.headers["access-control-allow-origin"]).toBe(
        "chrome-extension://abcdefghijklmnop",
      );

      const extensionPreflight = await app.inject({
        headers: {
          host: "127.0.0.1:7717",
          origin: "chrome-extension://abcdefghijklmnop",
          "access-control-request-headers": "content-type",
          "access-control-request-method": "POST",
          "sec-fetch-site": "cross-site",
        },
        method: "OPTIONS",
        url: "/api/ingest/snapshot",
      });
      expect(extensionPreflight.statusCode).toBe(204);
      expect(extensionPreflight.headers["access-control-allow-origin"]).toBe(
        "chrome-extension://abcdefghijklmnop",
      );
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces Host validation on a real loopback socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-host-socket-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const port = new URL(origin).port;

      await expect(requestStatus(origin, `127.0.0.1:${port}`)).resolves.toBe(
        200,
      );
      await expect(
        requestStatus(origin, "attacker.example:7717"),
      ).resolves.toBe(421);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
