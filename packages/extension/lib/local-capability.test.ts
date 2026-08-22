import { afterEach, describe, expect, it, vi } from "vitest";
import { localExtensionOriginHeaderName } from "@tabhub/shared";

const storage = vi.hoisted(() => ({
  value: undefined as unknown,
  get: vi.fn(async () => ({ "tabhub.localCapability": storage.value })),
  remove: vi.fn(async () => {
    storage.value = undefined;
  }),
  setAccessLevel: vi.fn(async () => undefined),
  set: vi.fn(async (items: Record<string, unknown>) => {
    storage.value = items["tabhub.localCapability"];
  }),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { id: "abcdefghijklmnopqrstuvwxyzabcdef" },
    storage: { local: storage },
  },
}));

import {
  consumePairingChallenge,
  localCapabilityFetch,
  PairingRequiredError,
  restrictLocalStorageToTrustedContexts,
} from "./local-capability";

const installationId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  storage.value = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("local extension capability", () => {
  it("restricts credential storage to trusted extension contexts", async () => {
    await restrictLocalStorageToTrustedContexts();
    expect(storage.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("consumes a one-time challenge without putting secrets in the URL", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ credential: "c".repeat(40), credentialVersion: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await consumePairingChallenge({
      challengeId: "323e4567-e89b-42d3-a456-426614174000",
      code: "p".repeat(40),
      installationId,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7717/api/local/pairing/consume",
      expect.any(Object),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("challengeId");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("323e4567"),
      expect.anything(),
    );
    expect(storage.value).toEqual({
      credential: "c".repeat(40),
      credentialVersion: 1,
      installationId,
    });
  });

  it("uses bearer and installation headers and clears rejected credentials", async () => {
    storage.value = {
      credential: "c".repeat(40),
      credentialVersion: 1,
      installationId,
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(localCapabilityFetch("/api/local/session-intents")).rejects.toBeInstanceOf(
      PairingRequiredError,
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"c".repeat(40)}`);
    expect(headers.get("x-tabhub-installation-id")).toBe(installationId);
    expect(headers.get(localExtensionOriginHeaderName)).toBe(
      "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
    );
    expect(storage.remove).toHaveBeenCalledWith("tabhub.localCapability");
  });

  it("fails closed on a malformed pairing response without storing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ credential: "short", credentialVersion: 1 }),
      ),
    );

    await expect(
      consumePairingChallenge({
        challengeId: "323e4567-e89b-42d3-a456-426614174000",
        code: "p".repeat(40),
        installationId,
      }),
    ).rejects.toBeInstanceOf(PairingRequiredError);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.value).toBeUndefined();
  });

  it("atomically replaces a rotated credential for the same installation", async () => {
    storage.value = {
      credential: "o".repeat(40),
      credentialVersion: 1,
      installationId,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ credential: "n".repeat(40), credentialVersion: 2 }),
      ),
    );

    await consumePairingChallenge({
      challengeId: "323e4567-e89b-42d3-a456-426614174000",
      code: "p".repeat(40),
      installationId,
    });
    expect(storage.value).toEqual({
      credential: "n".repeat(40),
      credentialVersion: 2,
      installationId,
    });
  });
});
