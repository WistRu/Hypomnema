import { describe, expect, it } from "vitest";

import { resolveServerHost } from "../src/runtime-config.js";

describe("server host configuration", () => {
  it("defaults blank values to the IPv4 loopback address", () => {
    expect(resolveServerHost(undefined)).toBe("127.0.0.1");
    expect(resolveServerHost("")).toBe("127.0.0.1");
    expect(resolveServerHost(" 127.0.0.1 ")).toBe("127.0.0.1");
  });

  it.each(["0.0.0.0", "::", "::1", "localhost", "192.168.1.10"])(
    "rejects non-canonical host %s instead of exposing the unauthenticated API",
    (host) => {
      expect(() => resolveServerHost(host)).toThrow(
        "TABHUB_HOST must be 127.0.0.1",
      );
    },
  );
});
