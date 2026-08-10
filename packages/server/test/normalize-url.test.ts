import { describe, expect, it } from "vitest";

import { normalizeUrl } from "../src/normalize-url.js";

describe("normalizeUrl", () => {
  it("preserves fragments while removing UTM tracking parameters", () => {
    expect(
      normalizeUrl(
        "https://Example.COM:443/read?utm_source=newsletter&b=2&UTM_Campaign=launch&a=1#section",
      ),
    ).toBe("https://example.com/read?b=2&a=1#section");
  });
});
