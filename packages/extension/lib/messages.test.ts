import { describe, expect, it } from "vitest";

import { isExtensionRequest } from "./messages";

describe("isExtensionRequest", () => {
  it.each(["chrome", "edge", "yandex", "other"])(
    "accepts an explicit supported browser identity: %s",
    (browser) => {
      expect(
        isExtensionRequest({ browser, type: "tabhub:browser-changed" }),
      ).toBe(true);
    },
  );

  it.each([
    { type: "tabhub:browser-changed" },
    { browser: "", type: "tabhub:browser-changed" },
    { browser: "firefox", type: "tabhub:browser-changed" },
    { browser: 7, type: "tabhub:browser-changed" },
  ])("rejects an invalid identity-change message: %#", (message) => {
    expect(isExtensionRequest(message)).toBe(false);
  });
});
