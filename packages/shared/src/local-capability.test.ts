import { describe, expect, it } from "vitest";

import {
  extensionOriginSchema,
  localExtensionOriginHeaderName,
} from "./index.js";

describe("local capability protocol", () => {
  it("publishes one canonical extension-origin header name", () => {
    expect(localExtensionOriginHeaderName).toBe("x-tabhub-extension-origin");
  });

  it.each([
    "http://127.0.0.1:7717",
    "chrome-extension://abcdefghijklmnop/",
    "chrome-extension://abcdefghijklmnop?spoofed=true",
    "chrome-extension://",
  ])("rejects a non-canonical extension origin: %s", (candidate) => {
    expect(extensionOriginSchema.safeParse(candidate).success).toBe(false);
  });
});
