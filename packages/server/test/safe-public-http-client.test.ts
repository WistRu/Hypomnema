import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { connect as connectTls, createServer as createTlsServer, type ConnectionOptions } from "node:tls";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createSafePublicHttpClient } from "../src/safe-public-http-client.js";

const fixedNow = "2026-08-14T12:00:00.000Z";
const digest = "a".repeat(64);
const localTlsKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDZGrY0LJ09NuUh
lm1Rwrwni7Pk6uamnVvHehrttaeVLxKpejS2yQtLH7sDVh/dAcmZ1dAbia+dj03n
3B1SYpwPTbLeuDZ5dwxDw6+iCKmWk76Wzg12dlmAlpZghD3gRIWaJmvaXAUP5nsa
KsjyXdm9w26HlaIExYR2xiYj4AbGjJnJ3WnCgXwsgMXlaSWCvS3y+HxbW+a4FBKc
E6mE6vkKNja73+SaXBJmRIlRPqBkqEF7w5DN5QOYBzKKAJ0D9Mj58yLu+Rq3rMwm
bShfJs/tcqPU1/vOroMZpXubRuznBOlHFW/nUUgdbA8aV2ipFIVxaQty8rDMGBLj
v7zkTr6bAgMBAAECggEAJVByAIWqgNruhtdT8rmFnUZlpPK6sehZ3e8esbyHER0G
GBro9IGZb1AE1I347ANiow4ctp7zkCERQsiSQZaxO/AezijbNAVCFmOLzE2w2DCM
kV7Y8YNl3rQDJJOWDvW4AMaZwu4N8K2setLftshqpDLyzFrrfeZ03fUwmPnoMDeo
6vmWBnzXnUqMqDNXHbATwMKbncdgsXKMG2yz882VyjQ8ae7EgcANQqKdlpC5cat/
nT1UgLM3DDtLgL12rqAFO/4p5QRQk4tzPB73Bn7c3/fN6QzDmutS0XkdkioZ4YPq
IzrKgmzor9XLGPNbuy5XxHR0P0/a0JaQRQyeMb7AAQKBgQD/T942jqhkImwzc617
0urJbhgUo0+zLo1QPJ9Ipkq6TBgwkfuVrxVwV44PqmXH8q6fwcxwn3+ee+BP4uxa
xXhHsquTJ5ksIXaWItJEOXdIwrZBmZ9bCUSJEyvC49/0f/QZJJhzriTMu/2pL6xF
RDrg6RPJGTfgFXC14bDS0oojaQKBgQDZsHxEp8ho5mUSvtLze0tzaLtlh0CZhLm5
U/tNOMXYYkDIYxed0P2QircyiLQeNX/IzPGhrjh92Y2eYQ6islWCGKgntN62xZMl
144XqNMWd1tXTYYomLYHMGLVjQvJl9fSJ3eVA4z06L0PCT/CVhNk1SVsz3RnP7ad
1cPueGIFYwKBgQD8Ve7VUzfhCBiS3cDYAgUlopdQRnyuJtNqOxBe2GRBLpY14wKZ
1VrGFvMETrCb5yJqKTurECks9Vgk/K4HpOYVTuS+40NDV6uCBdZ1sapQkolZ2sCi
VE2VgQoea+RcHd6evwmiQ7qBU0gI4GJOb3oV8qcoebE821Pzn6WJKKd5CQKBgAty
QjaB9AHAC5R+wCzZUNBSs3fVMspftjxOdCpNT+ne0LU4sKc1s/+Dq7pWgdIM0hlG
3XW46XOEmvO2+sQHSIO8tCrSUduea+xTdz87O041HHJsux8rWHbsTmYYMoR5HXoJ
ZTpKo4DFNBu0Ssv3JrHomz0rc11ydjG6acECR3UtAoGAMQlrLfGr/dbGtoAYWx4j
u0sjHb1ocSCGKJzoSTsXOGgDxKrj6ISqsyq+PRH0VakEjrttnQC407VsAJZw7Huz
th9EdAveqSNcDzavumyC98d4s/61QS1VI4Xfqg3xAcpi29uN2e6SgbyjeoBxYAnF
op3y86I0AN0drlTB70Hzsxk=
-----END PRIVATE KEY-----`;
const localTlsCertificate = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUWKQOY6RgwwRBDvG46/brqg23WegwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSd3d3LmNsb3VkZmxhcmUuY29tMB4XDTI2MDgxNTA0NTI1
NFoXDTM2MDgxMjA0NTI1NFowHTEbMBkGA1UEAwwSd3d3LmNsb3VkZmxhcmUuY29t
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Rq2NCydPTblIZZtUcK8
J4uz5Ormpp1bx3oa7bWnlS8SqXo0tskLSx+7A1Yf3QHJmdXQG4mvnY9N59wdUmKc
D02y3rg2eXcMQ8OvogiplpO+ls4NdnZZgJaWYIQ94ESFmiZr2lwFD+Z7GirI8l3Z
vcNuh5WiBMWEdsYmI+AGxoyZyd1pwoF8LIDF5Wklgr0t8vh8W1vmuBQSnBOphOr5
CjY2u9/kmlwSZkSJUT6gZKhBe8OQzeUDmAcyigCdA/TI+fMi7vkat6zMJm0oXybP
7XKj1Nf7zq6DGaV7m0bs5wTpRxVv51FIHWwPGldoqRSFcWkLcvKwzBgS47+85E6+
mwIDAQABo3IwcDAdBgNVHQ4EFgQUt/2BxNvWeOc2ZS81S1qUKbklV1wwHwYDVR0j
BBgwFoAUt/2BxNvWeOc2ZS81S1qUKbklV1wwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJ3d3cuY2xvdWRmbGFyZS5jb20wDQYJKoZIhvcNAQELBQADggEBABem
wgZgh/cWfWLZK7QNCsyRUjCe1dMk3yJA5mO/kX2G5WdViu95/64gfoqigUc64z87
BYhdFwnpmEGxx9/xC8VUDnrY4DpeMTtlFnRchkHcThGoZuM4ZgAy5H2LpsEcclm9
FO3+7kZx4RwvXuxy7PXoVeaam87Jk2oXvFsAoON6hf+cGDZgu3QQqQGBosPc7M5C
gSzOW0TA/Mi2BheRnOncIx9xGg3/Tnb65gyczXNLvswhX7VreSmkcv8mFSB1WjAN
KUt5uQtEdThgSMfq3nSJByPLl55gHreZrzhyU2ath0si0xAHJtkeZWkSe1pzBKex
3DoZ2u0ATIkoEWAJDA0=
-----END CERTIFICATE-----`;

function pageRequest() {
  return {
    version: "safe_public_http_request:v1" as const,
    actionKind: "page" as const,
    canonicalUrl: "https://www.cloudflare.com/",
    canonicalOrigin: "https://www.cloudflare.com",
    hostname: "www.cloudflare.com",
    pinnedIpv4: "104.16.132.229",
    answerSetDigest: digest,
    expiresAt: "2026-08-14T12:00:30.000Z",
  };
}

function wireResponse(overrides: Record<string, unknown> = {}) {
  const body = new TextEncoder().encode(
    "Useful public research material with concrete facts and verifiable evidence. ".repeat(8),
  );
  return {
    statusCode: 200,
    rawHeaders: ["Content-Type", "text/plain; charset=utf-8", "Content-Length", String(body.byteLength)],
    rawTrailers: [],
    body,
    applicationBytes: 128,
    ...overrides,
  };
}

describe("SafePublicHttpClient", () => {
  it("remains a closed server-internal dependency of only the C90 coordinator", () => {
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
    const importers = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts") && name !== "safe-public-http-client.ts")
      .filter((name) => readFileSync(`${sourceDirectory}/${name}`, "utf8")
        .includes('from "./safe-public-http-client.js"'));
    expect(importers).toEqual(["research-acquisition-coordinator.ts"]);
    expect(readFileSync(`${sourceDirectory}/safe-public-http-client.ts`, "utf8"))
      .not.toMatch(/\bfetch\s*\(/u);
  });

  it("proves peer-before-HTTP, successful public HTTPS, and expiry on real local TLS sockets", async () => {
    const body = Buffer.from(
      "Useful public research material with concrete facts and verifiable evidence. ".repeat(8),
    );
    let mode: "respond" | "hang" = "respond";
    let applicationBytesSeen = 0;
    const sockets = new Set<import("node:tls").TLSSocket>();
    const server = createTlsServer({ key: localTlsKey, cert: localTlsCertificate }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", (chunk: Buffer) => {
        applicationBytesSeen += chunk.byteLength;
        if (mode === "respond") {
          socket.end([
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain; charset=utf-8",
            `Content-Length: ${body.byteLength}`,
            "Connection: close",
            "",
            body.toString("utf8"),
          ].join("\r\n"));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    let presentPinnedPeer = false;
    const tlsDial = ((options: ConnectionOptions) => {
      const socket = connectTls({
        ...options,
        host: "127.0.0.1",
        port,
        ca: localTlsCertificate,
      });
      if (presentPinnedPeer) {
        Object.defineProperty(socket, "remoteAddress", {
          configurable: true,
          get: () => options.host,
        });
      }
      return socket;
    }) as typeof connectTls;
    const client = createSafePublicHttpClient({ tlsConnect: tlsDial });
    const request = () => ({
      ...pageRequest(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    try {
      const peerMismatch = await client.request(request());
      expect(peerMismatch).toEqual({
        kind: "blocked",
        code: "TRANSPORT_TLS_FAILURE",
        counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 0 },
      });
      expect(applicationBytesSeen).toBe(0);

      presentPinnedPeer = true;
      const success = await client.request(request());
      expect(success).toMatchObject({
        kind: "success",
        status: 200,
        counters: { dnsCalls: 0, connectAttempts: 1 },
      });
      expect(success.counters.httpApplicationBytes).toBeGreaterThan(0);
      expect(applicationBytesSeen).toBeGreaterThan(0);

      mode = "hang";
      const expiry = await client.request({
        ...pageRequest(),
        expiresAt: new Date(Date.now() + 75).toISOString(),
      });
      expect(expiry).toMatchObject({
        kind: "blocked",
        code: "CONSENT_EXPIRED_IN_FLIGHT",
        counters: { dnsCalls: 0, connectAttempts: 1 },
      });
      expect(expiry.counters.httpApplicationBytes).toBeGreaterThan(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("performs one bounded all/verbatim lookup and rejects a mixed set before connect", async () => {
    const lookup = vi.fn(async () => [
      { address: "104.16.132.229", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const connect = vi.fn();
    const client = createSafePublicHttpClient({
      lookup,
      connect,
      clock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    const result = await client.acquire({
      version: "safe_public_http_request:v1",
      actionKind: "page",
      url: "https://www.cloudflare.com/",
      expiresAt: "2026-08-14T12:00:15.000Z",
    });
    expect(result).toEqual({
      kind: "blocked",
      code: "POLICY_BLOCKED",
      counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 },
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("www.cloudflare.com", { all: true, verbatim: true });
    expect(connect).not.toHaveBeenCalled();
  });

  it("uses one DNS call and one connection to the deterministic pinned IPv4 without failover", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:4700:4700::1111", family: 6 as const },
      { address: "104.16.133.229", family: 4 as const },
      { address: "104.16.132.229", family: 4 as const },
    ]);
    const connect = vi.fn(async () => wireResponse());
    const client = createSafePublicHttpClient({
      lookup,
      connect,
      clock: () => new Date(fixedNow),
    });
    const result = await client.acquire({
      version: "safe_public_http_request:v1",
      actionKind: "page",
      url: "https://www.cloudflare.com/#not-sent",
      expiresAt: "2026-08-14T12:00:15.000Z",
    });
    expect(result).toMatchObject({
      kind: "success",
      selectedIpv4: "104.16.132.229",
      counters: { dnsCalls: 1, connectAttempts: 1, httpApplicationBytes: 128 },
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      canonicalUrl: "https://www.cloudflare.com/",
      hostname: "www.cloudflare.com",
      pinnedIpv4: "104.16.132.229",
    }));
  });

  it("sanitizes TLS/peer rejection and proves no HTTP application bytes were released", async () => {
    const peerError = new Error("SAFE_TLS_PEER_REJECTED");
    Object.defineProperty(peerError, "applicationBytes", { value: 0 });
    const connect = vi.fn(async () => Promise.reject(peerError));
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect,
    });
    await expect(client.request(pageRequest())).resolves.toEqual({
      kind: "blocked",
      code: "TRANSPORT_TLS_FAILURE",
      counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 0 },
    });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("maps a truncated response to PARTIAL_RESPONSE without leaking the socket error", async () => {
    const partial = new Error("SAFE_PARTIAL_RESPONSE");
    Object.defineProperty(partial, "applicationBytes", { value: 128 });
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect: vi.fn(async () => Promise.reject(partial)),
    });
    await expect(client.request(pageRequest())).resolves.toEqual({
      kind: "blocked",
      code: "PARTIAL_RESPONSE",
      counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 128 },
    });
  });

  it("terminalizes a partial 206 response with the dedicated closed code", async () => {
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect: vi.fn(async () => wireResponse({ statusCode: 206 })),
    });
    await expect(client.request(pageRequest())).resolves.toEqual({
      kind: "blocked",
      code: "PARTIAL_RESPONSE",
      counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 128 },
      retryAfter: null,
    });
  });

  it("freezes connect, headers, idle, total, and consent-expiry deadlines at request start", async () => {
    const connect = vi.fn(async () => wireResponse());
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect,
    });
    await expect(client.request({
      ...pageRequest(),
      expiresAt: "2026-08-14T12:00:10.000Z",
    })).resolves.toMatchObject({ kind: "success" });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      startedAt: Date.parse(fixedNow),
      connectDeadlineAt: Date.parse("2026-08-14T12:00:05.000Z"),
      headersDeadlineAt: Date.parse("2026-08-14T12:00:08.000Z"),
      deadlineAt: Date.parse("2026-08-14T12:00:10.000Z"),
      bodyIdleTimeoutMs: 3_000,
      deadlineCode: "SAFE_CONSENT_EXPIRED",
    }));
  });

  it("reports the 64 KiB response limit without exposing transport details", async () => {
    const body = new Uint8Array(65_537).fill(0x61);
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect: vi.fn(async () => wireResponse({
        body,
        rawHeaders: ["Content-Type", "text/plain", "Content-Length", String(body.byteLength)],
      })),
    });
    await expect(client.request(pageRequest())).resolves.toEqual({
      kind: "blocked",
      code: "RESPONSE_SIZE_LIMIT",
      counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 128 },
    });
  });

  it("fails closed on raw header, trailer, compression, length, media-type, and UTF-8 violations", async () => {
    const cases = [
      wireResponse({ rawHeaders: Array.from({ length: 202 }, (_, index) => index % 2 === 0 ? `X-${index}` : "v") }),
      wireResponse({ rawHeaders: ["Content-Type", "text/plain", "content-type", "text/html"] }),
      wireResponse({ rawHeaders: ["Content-Encoding", "gzip", "Content-Type", "text/plain"] }),
      wireResponse({ rawHeaders: ["Content-Length", "1", "Transfer-Encoding", "chunked", "Content-Type", "text/plain"] }),
      wireResponse({ rawTrailers: ["Digest", "sha-256=abc"] }),
      wireResponse({ rawHeaders: ["Content-Type", "application/json"] }),
      wireResponse({ rawHeaders: ["Content-Type", "text/plain; charset=utf-8; charset=utf-8"] }),
    ];
    for (const response of cases) {
      const client = createSafePublicHttpClient({
        clock: () => new Date(fixedNow),
        connect: vi.fn(async () => response),
      });
      await expect(client.request(pageRequest())).resolves.toMatchObject({
        kind: "blocked",
        code: "POLICY_BLOCKED",
      });
    }

    const invalidUtf8 = new Uint8Array([0xc3, 0x28, ...new Uint8Array(300).fill(0x61)]);
    const client = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect: vi.fn(async () => wireResponse({
        body: invalidUtf8,
        rawHeaders: ["Content-Type", "text/plain", "Content-Length", String(invalidUtf8.byteLength)],
      })),
    });
    await expect(client.request(pageRequest())).resolves.toMatchObject({
      kind: "blocked",
      code: "INVALID_UTF8",
    });
  });

  it("accepts only exact robots 200 text/plain plus body-independent 404/410", async () => {
    for (const statusCode of [404, 410] as const) {
      const client = createSafePublicHttpClient({
        clock: () => new Date(fixedNow),
        connect: vi.fn(async () => wireResponse({ statusCode, rawHeaders: [], body: new Uint8Array() })),
      });
      await expect(client.request({ ...pageRequest(), actionKind: "robots" })).resolves.toMatchObject({
        kind: "success",
        status: statusCode,
        contentType: null,
        usability: null,
      });
    }

    const htmlClient = createSafePublicHttpClient({
      clock: () => new Date(fixedNow),
      connect: vi.fn(async () => wireResponse({ rawHeaders: ["Content-Type", "text/html"] })),
    });
    await expect(htmlClient.request({ ...pageRequest(), actionKind: "robots" })).resolves
      .toMatchObject({ kind: "blocked", code: "POLICY_BLOCKED" });
  });
});
