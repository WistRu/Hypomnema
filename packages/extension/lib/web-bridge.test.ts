import { describe, expect, it } from "vitest";

import {
  createBridgeResponse,
  parseBridgeRequest,
  toAppExtensionRequest,
} from "./web-bridge";

function baseRequest() {
  return {
    channel: "tabhub-extension-bridge",
    requestId: "request-1",
    source: "tabhub-web",
    version: 4,
  };
}

describe("parseBridgeRequest", () => {
  it("parses and scopes an exact physical-tab activation request", () => {
    const parsed = parseBridgeRequest({
      ...baseRequest(),
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
      type: "activate-tab",
    });

    expect(parsed).toEqual({
      ...baseRequest(),
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
      type: "activate-tab",
    });
    expect(parsed && toAppExtensionRequest(parsed)).toEqual({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
      type: "tabhub:app-activate-tab",
    });
  });

  it("parses one strict scoped physical-tab command", () => {
    const parsed = parseBridgeRequest({
      ...baseRequest(),
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        destination: { kind: "new-window" },
        kind: "move",
        targets: [
          { tabId: 42, expectedUrl: "https://example.com/exact" },
        ],
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      type: "tab-command",
    });

    expect(parsed).toMatchObject({
      command: {
        destination: { kind: "new-window" },
        kind: "move",
      },
      type: "tab-command",
    });
    expect(parsed && toAppExtensionRequest(parsed)).toEqual({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        destination: { kind: "new-window" },
        kind: "move",
        targets: [
          { tabId: 42, expectedUrl: "https://example.com/exact" },
        ],
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      type: "tabhub:app-tab-command",
    });
  });

  it.each([
    {
      ...baseRequest(),
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: -1,
      type: "activate-tab",
    },
    { ...baseRequest(), type: "close-obvious-duplicates" },
    {
      ...baseRequest(),
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "close-obvious-duplicates",
    },
    {
      ...baseRequest(),
      confirmed: false,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "close-obvious-duplicates",
    },
    {
      ...baseRequest(),
      confirmed: true,
      previewId: "not-a-preview-id",
      type: "close-obvious-duplicates",
    },
    { ...baseRequest(), extra: true, type: "probe" },
    { ...baseRequest(), type: "probe", version: 2 },
    { ...baseRequest(), requestId: "spaces are rejected", type: "probe" },
    { ...baseRequest(), source: "untrusted-page", type: "probe" },
    {
      ...baseRequest(),
      type: "preview-obvious-duplicates",
      urls: ["https://example.com/same"],
    },
  ])("rejects a malformed or over-permissive page envelope: %#", (value) => {
    expect(parseBridgeRequest(value)).toBeUndefined();
  });
});

describe("createBridgeResponse", () => {
  it.each([3, 4, 5])(
    "accepts supported relay protocol v%s in a probe response",
    (commandProtocolVersion) => {
      const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });
      expect(
        createBridgeResponse(request!, {
          data: {
            available: true,
            browser: "chrome",
            browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
            commandProtocolVersion,
            controlWindowId: 90,
            extensionOrigin: "chrome-extension://abcdefghijklmnop",
            installationId: "123e4567-e89b-42d3-a456-426614174000",
            pendingUndos: [],
            windows: [],
          },
          ok: true,
          type: "probe",
        }),
      ).toMatchObject({
        ok: true,
        data: { commandProtocolVersion },
      });
    },
  );

  it("rejects an unsupported relay protocol in a probe response", () => {
    const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });
    expect(
      createBridgeResponse(request!, {
        data: {
          available: true,
          browser: "chrome",
          browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
          commandProtocolVersion: 2,
          controlWindowId: 90,
          extensionOrigin: "chrome-extension://abcdefghijklmnop",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          pendingUndos: [],
          windows: [],
        },
        ok: true,
        type: "probe",
      }),
    ).toMatchObject({ ok: false });
  });

  it("correlates the background result without reflecting request fields", () => {
    const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });
    expect(request).toBeDefined();

    expect(
      createBridgeResponse(request!, {
        data: {
          available: true,
          browser: "chrome",
          browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
          commandProtocolVersion: 4,
          controlWindowId: 90,
          extensionOrigin: "chrome-extension://abcdefghijklmnop",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          pendingUndos: [
            {
              count: 2,
              expiresAt: 100_000,
              undoId: "423e4567-e89b-42d3-a456-426614174000",
            },
          ],
          windows: [{ focused: true, tabCount: 2, windowId: 90 }],
        },
        ok: true,
        type: "probe",
      }),
    ).toEqual({
      ...baseRequest(),
      source: "tabhub-extension",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        commandProtocolVersion: 4,
        controlWindowId: 90,
        extensionOrigin: "chrome-extension://abcdefghijklmnop",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        pendingUndos: [
          {
            count: 2,
            expiresAt: 100_000,
            undoId: "423e4567-e89b-42d3-a456-426614174000",
          },
        ],
        windows: [{ focused: true, tabCount: 2, windowId: 90 }],
      },
    });
  });

  it("turns a malformed background reply into a correlated rejection", () => {
    const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });

    expect(createBridgeResponse(request!, { unexpected: true })).toMatchObject({
      error: "TabHub extension returned an invalid bridge response.",
      ok: false,
      requestId: "request-1",
      type: "probe",
    });
  });

  it("rejects a probe reply that attempts to expose capability material", () => {
    const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });

    expect(
      createBridgeResponse(request!, {
        data: {
          available: true,
          browser: "chrome",
          browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
          commandProtocolVersion: 4,
          controlWindowId: 90,
          credential: "must-never-reach-page-js",
          extensionOrigin: "chrome-extension://abcdefghijklmnop",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          pendingUndos: [],
          windows: [],
        },
        ok: true,
        type: "probe",
      }),
    ).toMatchObject({
      error: "TabHub extension returned an invalid bridge response.",
      ok: false,
      requestId: "request-1",
      type: "probe",
    });
  });
});

describe("pairing handover", () => {
  const challengeId = "322e4567-e89b-42d3-a456-426614174000";
  const installationId = "123e4567-e89b-42d3-a456-426614174000";
  const code = "PAIRING-CODE-DOES-NOT-ENTER-A-URL-1234567890";

  it("parses a pairing handover and forwards it to the background", () => {
    const parsed = parseBridgeRequest({
      ...baseRequest(),
      challengeId,
      code,
      installationId,
      type: "pair",
    });

    expect(parsed).toEqual({
      ...baseRequest(),
      challengeId,
      code,
      installationId,
      type: "pair",
    });
    expect(toAppExtensionRequest(parsed!)).toEqual({
      challengeId,
      code,
      installationId,
      type: "tabhub:app-pair",
    });
  });

  it("rejects a pairing handover carrying anything beyond the challenge it names", () => {
    expect(parseBridgeRequest({
      ...baseRequest(),
      challengeId,
      code,
      installationId,
      extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaa",
      type: "pair",
    })).toBeUndefined();
  });

  it("rejects a pairing handover with a malformed challenge, code or installation", () => {
    expect(parseBridgeRequest({ ...baseRequest(), challengeId: "nope", code, installationId, type: "pair" }))
      .toBeUndefined();
    expect(parseBridgeRequest({ ...baseRequest(), challengeId, code: "", installationId, type: "pair" }))
      .toBeUndefined();
    expect(parseBridgeRequest({ ...baseRequest(), challengeId, code, installationId: "nope", type: "pair" }))
      .toBeUndefined();
  });
});
