import { describe, expect, it } from "vitest";

import {
  isAllowedAppMessageSender,
  isAllowedAppPageUrl,
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

  it("accepts probe, activation, and session-scoped tab commands", () => {
    expect(isExtensionRequest({ type: "tabhub:app-probe" })).toBe(true);
    expect(
      isExtensionRequest({
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        tabId: 42,
        type: "tabhub:app-activate-tab",
      }),
    ).toBe(true);
    expect(
      isExtensionRequest({
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        command: {
          kind: "set-muted",
          targets: [
            { tabId: 42, expectedUrl: "https://example.com/exact" },
          ],
          value: true,
        },
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        type: "tabhub:app-tab-command",
      }),
    ).toBe(true);
  });

  it.each([
    {
      browser: "firefox",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
      type: "tabhub:app-activate-tab",
    },
    {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "not-an-installation-id",
      tabId: 42,
      type: "tabhub:app-activate-tab",
    },
    {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        kind: "discard",
        targets: [
          { tabId: 42, expectedUrl: "https://example.com" },
          { tabId: 42, expectedUrl: "https://example.com/duplicate-id" },
        ],
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      type: "tabhub:app-tab-command",
    },
    {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        kind: "close",
        confirmed: false,
        previewId: "323e4567-e89b-42d3-a456-426614174000",
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      type: "tabhub:app-tab-command",
    },
    {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: -1,
      type: "tabhub:app-activate-tab",
    },
    {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 7,
      type: "tabhub:app-activate-tab",
      unexpected: true,
    },
    {
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 7,
      type: "tabhub:app-activate-tab",
    },
    {
      browser: "chrome",
      browserSessionId: "not-a-browser-session-id",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 7,
      type: "tabhub:app-activate-tab",
    },
    { type: "tabhub:app-close-obvious-duplicates" },
    {
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "tabhub:app-close-obvious-duplicates",
    },
    {
      type: "tabhub:app-preview-obvious-duplicates",
      urls: ["https://example.com/same"],
    },
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
  ])("rejects an unsafe app action request: %#", (message) => {
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

describe("isAllowedAppPageUrl", () => {
  it("recognizes every local TabHub page that relay commands must protect", () => {
    expect(isAllowedAppPageUrl("http://127.0.0.1:7717/app/")).toBe(true);
    expect(isAllowedAppPageUrl("http://localhost:7717/app/?view=open")).toBe(
      true,
    );
    expect(isAllowedAppPageUrl("https://example.com/app/")).toBe(false);
    expect(isAllowedAppPageUrl(undefined)).toBe(false);
  });
});
