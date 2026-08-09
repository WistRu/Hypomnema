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
    version: 2,
  };
}

describe("parseBridgeRequest", () => {
  it("parses a strict confirmed close envelope and trims its unique URLs", () => {
    const parsed = parseBridgeRequest({
      ...baseRequest(),
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "close-obvious-duplicates",
    });

    expect(parsed).toEqual({
      ...baseRequest(),
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "close-obvious-duplicates",
    });
    expect(parsed && toAppExtensionRequest(parsed)).toEqual({
      confirmed: true,
      previewId: "123e4567-e89b-42d3-a456-426614174001",
      type: "tabhub:app-close-obvious-duplicates",
    });
  });

  it.each([
    { ...baseRequest(), type: "close-obvious-duplicates" },
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
    { ...baseRequest(), requestId: "spaces are rejected", type: "probe" },
    { ...baseRequest(), source: "untrusted-page", type: "probe" },
    {
      ...baseRequest(),
      type: "preview-obvious-duplicates",
      urls: ["not a URL"],
    },
  ])("rejects a malformed or over-permissive page envelope: %#", (value) => {
    expect(parseBridgeRequest(value)).toBeUndefined();
  });
});

describe("createBridgeResponse", () => {
  it("correlates the background result without reflecting request fields", () => {
    const request = parseBridgeRequest({ ...baseRequest(), type: "probe" });
    expect(request).toBeDefined();

    expect(
      createBridgeResponse(request!, {
        data: {
          available: true,
          browser: "chrome",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
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
        installationId: "123e4567-e89b-42d3-a456-426614174000",
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
});
