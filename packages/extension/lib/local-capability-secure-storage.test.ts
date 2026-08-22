import { describe, expect, it, vi } from "vitest";

const secureStorage = vi.hoisted(() => ({
  get: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  setAccessLevel: vi.fn(async () => {
    throw new Error("storage access hardening failed");
  }),
}));

vi.mock("wxt/browser", () => ({
  browser: { storage: { local: secureStorage } },
}));

import { consumePairingChallenge } from "./local-capability";

describe("local capability secure-storage gate", () => {
  it("does not consume or store a credential when trusted storage is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      consumePairingChallenge({
        challengeId: "323e4567-e89b-42d3-a456-426614174000",
        code: "p".repeat(40),
        installationId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).rejects.toThrow("storage access hardening failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secureStorage.set).not.toHaveBeenCalled();
  });
});
