import { describe, expect, it } from "vitest";

import {
  isAllowedAppMessageSender,
  isExtensionRequest,
} from "./messages";

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

  it("accepts probe, scoped preview, and explicitly-confirmed close requests", () => {
    expect(isExtensionRequest({ type: "tabhub:app-probe" })).toBe(true);
    expect(
      isExtensionRequest({
        type: "tabhub:app-preview-obvious-duplicates",
        urls: [" https://example.com/same "],
      }),
    ).toBe(true);
    expect(
      isExtensionRequest({
        confirmed: true,
        previewId: "123e4567-e89b-42d3-a456-426614174001",
        type: "tabhub:app-close-obvious-duplicates",
      }),
    ).toBe(true);
  });

  it.each([
    { type: "tabhub:app-close-obvious-duplicates" },
    { confirmed: false, type: "tabhub:app-close-obvious-duplicates" },
    {
      confirmed: true,
      previewId: "not-a-preview-id",
      type: "tabhub:app-close-obvious-duplicates",
    },
    {
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "tabhub:app-close-obvious-duplicates",
      urls: ["https://example.com/same"],
    },
    {
      type: "tabhub:app-preview-obvious-duplicates",
      urls: ["not a URL"],
    },
    {
      type: "tabhub:app-preview-obvious-duplicates",
      urls: ["https://example.com", "https://example.com"],
    },
  ])("rejects unsafe duplicate action request: %#", (message) => {
    expect(isExtensionRequest(message)).toBe(false);
  });
});

describe("isAllowedAppMessageSender", () => {
  it.each([
    "http://127.0.0.1:7717/app/",
    "http://127.0.0.1:7717/app/index.html?view=duplicates",
    "http://localhost:7717/app/",
  ])("accepts the exact local TabHub app surface: %s", (url) => {
    expect(isAllowedAppMessageSender({ url })).toBe(true);
  });

  it.each([
    "http://127.0.0.1:7717/application/",
    "http://127.0.0.1:7718/app/",
    "http://evil.example/app/",
    "https://127.0.0.1:7717/app/",
    "chrome-extension://abc/popup.html",
  ])("rejects non-app message senders: %s", (url) => {
    expect(isAllowedAppMessageSender({ tab: { url } })).toBe(false);
  });
});
