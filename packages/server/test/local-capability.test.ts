import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { localExtensionOriginHeaderName } from "@tabhub/shared";

import { createApp } from "../src/app.js";

const flags = {
  context: true,
  logicalImportance: false,
  priorityShadow: false,
  research: false,
  resources: false,
} as const;
const install1 = "122e4567-e89b-42d3-a456-426614174000";
const install2 = "222e4567-e89b-42d3-a456-426614174000";
const session = "322e4567-e89b-42d3-a456-426614174000";
const origin = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";

function cookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = String(response.headers["set-cookie"]);
  return setCookie.split(";", 1)[0]!;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-local-capability-"));
  let now = new Date("2026-08-12T10:00:00.000Z");
  const app = createApp({
    databasePath: join(directory, "tabhub.sqlite"),
    logger: false,
    featureFlags: flags,
    clock: () => now,
    localDevProxySecret: "dev-proxy-canary-secret-812",
  });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": "dev-proxy-canary-secret-812" },
  });
  return {
    app,
    directory,
    cookie: cookie(bootstrap),
    setNow: (value: string) => (now = new Date(value)),
  };
}

async function pair(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  webCookie: string,
  installationId = install1,
) {
  const challenge = await app.inject({
    method: "POST",
    url: "/api/local/pairing/challenges",
    headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
    payload: { installationId, extensionOrigin: origin },
  });
  expect(challenge.statusCode).toBe(200);
  const consumed = await app.inject({
    method: "POST",
    url: "/api/local/pairing/consume",
    headers: { origin },
    payload: {
      challengeId: challenge.json().challengeId,
      installationId,
      code: challenge.json().code,
    },
  });
  expect(consumed.statusCode).toBe(200);
  return { challenge: challenge.json(), credential: consumed.json().credential as string };
}

describe("local UI capability", () => {
  it("issues a production web session only on genuine top-level app navigation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-web-session-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      featureFlags: flags,
      webRoot: directory,
    });
    try {
      const ordinary = await app.inject({ method: "GET", url: "/app" });
      expect(ordinary.headers["set-cookie"]).toBeUndefined();
      const navigation = await app.inject({
        method: "GET",
        url: "/app",
        headers: {
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": "cross-site",
        },
      });
      expect(String(navigation.headers["set-cookie"])).toContain("HttpOnly");
      expect(String(navigation.headers["set-cookie"])).toContain("SameSite=Strict");
      expect(String(navigation.headers["set-cookie"])).toContain(
        "Path=/api; Max-Age=28800",
      );
      expect(String(navigation.headers["set-cookie"])).toContain(
        "Path=/api/local; Max-Age=0",
      );
      const response = await app.inject({
        method: "GET",
        url: "/api/local/context/search?q=x&logicalPageId=1",
        headers: {
          cookie: cookie(navigation),
          "sec-fetch-site": "same-origin",
        },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a trusted web session, pairs two installs on one origin, rotates, revokes, and never persists plaintext", async () => {
    const f = await fixture();
    try {
      expect(
        (await f.app.inject({ method: "GET", url: "/api/local/context/search?q=x&logicalPageId=1" })).statusCode,
      ).toBe(401);
      const first = await pair(f.app, f.cookie, install1);
      const second = await pair(f.app, f.cookie, install2);
      expect(second.credential).not.toBe(first.credential);

      const collisionDatabase = new Database(join(f.directory, "tabhub.sqlite"));
      const firstHash = collisionDatabase
        .prepare(`
          SELECT credential_hash
          FROM local_installation_capabilities
          WHERE installation_id = ?
        `)
        .pluck()
        .get(install1) as Buffer;
      expect(() =>
        collisionDatabase
          .prepare(`
            UPDATE local_installation_capabilities
            SET credential_hash = ?
            WHERE installation_id = ?
          `)
          .run(firstHash, install2),
      ).toThrow(/UNIQUE constraint failed/);
      collisionDatabase.close();

      const firstStillValid = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${first.credential}`,
          "x-tabhub-installation-id": install1,
        },
      });
      const collisionNotBoundToSecond = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install2}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${first.credential}`,
          "x-tabhub-installation-id": install2,
        },
      });
      expect(firstStillValid.statusCode).toBe(200);
      expect(collisionNotBoundToSecond.statusCode).toBe(401);

      const replay = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/consume",
        headers: { origin },
        payload: { ...first.challenge, installationId: install1 },
      });
      expect(replay.statusCode).toBe(401);

      const rotated = await pair(f.app, f.cookie, install1);
      const oldAuth = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${first.credential}`,
          "x-tabhub-installation-id": install1,
        },
      });
      const newAuth = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${rotated.credential}`,
          "x-tabhub-installation-id": install1,
        },
      });
      expect(oldAuth.statusCode).toBe(401);
      expect(newAuth.statusCode).toBe(200);

      expect(
        (
          await f.app.inject({
            method: "DELETE",
            url: `/api/local/capabilities/${install2}`,
            headers: {
              origin,
              authorization: `Bearer ${rotated.credential}`,
              "x-tabhub-installation-id": install1,
            },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            method: "DELETE",
            url: `/api/local/capabilities/${install1}`,
            headers: { cookie: f.cookie, "sec-fetch-site": "same-origin" },
          })
        ).statusCode,
      ).toBe(204);

      const bytes = await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(f.directory, "tabhub.sqlite")),
      );
      for (const canary of [
        first.credential,
        second.credential,
        rotated.credential,
        first.challenge.code as string,
      ]) {
        expect(bytes.includes(Buffer.from(canary))).toBe(false);
      }
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("authenticates an extension GET without Origin while rejecting an explicit origin mismatch", async () => {
    const f = await fixture();
    try {
      const paired = await pair(f.app, f.cookie, install1);
      const url = `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`;
      const headers = {
        authorization: `Bearer ${paired.credential}`,
        "x-tabhub-installation-id": install1,
        "x-tabhub-extension-origin": origin,
      };

      const withoutBrowserOrigin = await f.app.inject({
        method: "GET",
        url,
        headers,
      });
      expect(withoutBrowserOrigin.statusCode).toBe(200);

      const wrongExplicitOrigin = await f.app.inject({
        method: "GET",
        url,
        headers: {
          ...headers,
          "x-tabhub-extension-origin": "chrome-extension://different",
        },
      });
      expect(wrongExplicitOrigin.statusCode).toBe(401);

      const inconsistentBrowserOrigin = await f.app.inject({
        method: "GET",
        url,
        headers: {
          ...headers,
          origin: "chrome-extension://different",
        },
      });
      expect(inconsistentBrowserOrigin.statusCode).toBe(401);
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("allows the explicit extension-origin header through CORS preflight", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: "OPTIONS",
        url: "/api/local/session-intents",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": [
            "authorization",
            "x-tabhub-installation-id",
            localExtensionOriginHeaderName,
          ].join(","),
        },
      });

      expect(response.statusCode).toBe(204);
      const allowedHeaders = String(
        response.headers["access-control-allow-headers"],
      ).toLowerCase();
      expect(allowedHeaders).toContain("authorization");
      expect(allowedHeaders).toContain("x-tabhub-installation-id");
      expect(allowedHeaders).toContain(localExtensionOriginHeaderName);
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("invalidates outstanding pairing challenges when an installation is revoked", async () => {
    const f = await fixture();
    try {
      const paired = await pair(f.app, f.cookie, install1);
      const challenge = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/challenges",
        headers: { cookie: f.cookie, "sec-fetch-site": "same-origin" },
        payload: { installationId: install1, extensionOrigin: origin },
      });
      expect(challenge.statusCode).toBe(200);

      const revoked = await f.app.inject({
        method: "DELETE",
        url: `/api/local/capabilities/${install1}`,
        headers: { cookie: f.cookie, "sec-fetch-site": "same-origin" },
      });
      expect(revoked.statusCode).toBe(204);

      const oldCredential = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${paired.credential}`,
          "x-tabhub-installation-id": install1,
        },
      });
      expect(oldCredential.statusCode).toBe(401);

      const consumed = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/consume",
        headers: { origin },
        payload: {
          challengeId: challenge.json().challengeId,
          installationId: install1,
          code: challenge.json().code,
        },
      });
      expect(consumed.statusCode).toBe(401);
      expect(consumed.json()).toEqual({
        error: "LOCAL_CAPABILITY_REQUIRED",
        message: "A valid local capability is required",
      });
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("expires and bounds challenges without blocking a replacement", async () => {
    const f = await fixture();
    try {
      const challenge = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/challenges",
        headers: { cookie: f.cookie, "sec-fetch-site": "same-origin" },
        payload: { installationId: install1, extensionOrigin: origin },
      });
      f.setNow("2026-08-12T10:06:00.000Z");
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/local/pairing/consume",
            headers: { origin },
            payload: {
              challengeId: challenge.json().challengeId,
              installationId: install1,
              code: challenge.json().code,
            },
          })
        ).statusCode,
      ).toBe(401);
      const replacement = await pair(f.app, f.cookie, install1);
      expect(replacement.credential).toBeTypeOf("string");
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("fails closed instead of choosing an arbitrary capability in a malformed database", async () => {
    const f = await fixture();
    try {
      const first = await pair(f.app, f.cookie, install1);
      await pair(f.app, f.cookie, install2);
      const database = new Database(join(f.directory, "tabhub.sqlite"));
      database.exec("DROP INDEX local_capability_credential_hash_idx");
      const firstHash = database
        .prepare(`
          SELECT credential_hash FROM local_installation_capabilities
          WHERE installation_id = ?
        `)
        .pluck()
        .get(install1) as Buffer;
      database
        .prepare(`
          UPDATE local_installation_capabilities
          SET credential_hash = ? WHERE installation_id = ?
        `)
        .run(firstHash, install2);
      database.close();

      const response = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?installationId=${install1}&browserSessionId=${session}&browserTabId=1`,
        headers: {
          origin,
          authorization: `Bearer ${first.credential}`,
          "x-tabhub-installation-id": install1,
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "LOCAL_CAPABILITY_REQUIRED",
        message: "A valid local capability is required",
      });
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("fails pairing generically across origin, installation, code, and bounded attempts", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: "/api/local/context/search?q=x&logicalPageId=1",
            headers: { cookie: f.cookie, "sec-fetch-site": "same-site" },
          })
        ).statusCode,
      ).toBe(401);
      const challenge = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/challenges",
        headers: { cookie: f.cookie, "sec-fetch-site": "same-origin" },
        payload: { installationId: install1, extensionOrigin: origin },
      });
      const attempts = [
        { origin: "chrome-extension://different", installationId: install1, code: challenge.json().code },
        { origin, installationId: install2, code: challenge.json().code },
        { origin, installationId: install1, code: "x".repeat(43) },
        { origin, installationId: install1, code: "y".repeat(43) },
        { origin, installationId: install1, code: "z".repeat(43) },
        { origin, installationId: install1, code: challenge.json().code },
      ];
      const bodies = [];
      for (const attempt of attempts) {
        const response = await f.app.inject({
          method: "POST",
          url: "/api/local/pairing/consume",
          headers: { origin: attempt.origin },
          payload: {
            challengeId: challenge.json().challengeId,
            installationId: attempt.installationId,
            code: attempt.code,
          },
        });
        expect(response.statusCode).toBe(401);
        bodies.push(response.body);
      }
      expect(new Set(bodies).size).toBe(1);
      expect((await pair(f.app, f.cookie, install1)).credential).toBeTypeOf("string");
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("logs route templates and operational status without secret-bearing URL, headers, or bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-safe-logs-"));
    const records: string[] = [];
    const write = (...values: unknown[]) => records.push(JSON.stringify(values));
    const logger = {
      level: "info",
      fatal: write,
      error: write,
      warn: write,
      info: write,
      debug: write,
      trace: write,
      silent: write,
      child() {
        return this;
      },
    } as unknown as FastifyBaseLogger;
    const proxySecret = "PRIVATE_PROXY_SECRET_812";
    const rawQuery = "PRIVATE_QUERY_CANARY_812";
    const bodyCanary = "PRIVATE_CONTEXT_BODY_812";
    const keyCanary = "PRIVATE_IDEMPOTENCY_812";
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger,
      featureFlags: flags,
      localDevProxySecret: proxySecret,
    });
    try {
      await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": proxySecret },
      });
      await app.inject({
        method: "GET",
        url: `/api/local/context/search?q=${rawQuery}&logicalPageId=1`,
        headers: { authorization: "Bearer PRIVATE_BEARER_812" },
      });
      await app.inject({
        method: "POST",
        url: "/api/agent/pages/999/context",
        payload: {
          kind: "append",
          entryKind: "note",
          body: bodyCanary,
          provenance: { method: "on_behalf_of_user" },
          idempotencyKey: keyCanary,
        },
      });
      const logs = records.join("\n");
      for (const secret of [
        proxySecret,
        rawQuery,
        bodyCanary,
        keyCanary,
        "PRIVATE_BEARER_812",
      ]) {
        expect(logs).not.toContain(secret);
      }
      expect(logs).toContain("/api/local/context/search");
      expect(logs).toContain("statusCode");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
