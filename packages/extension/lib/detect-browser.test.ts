import { describe, expect, it } from "vitest";

import { detectBrowserFromUserAgent } from "./detect-browser";

describe("detectBrowserFromUserAgent", () => {
  it("names Yandex before Chrome, because its agent claims both", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36",
      ),
    ).toBe("yandex");
  });

  it("names Edge before Chrome, because its agent claims both", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
      ),
    ).toBe("edge");
  });

  it("names Chrome when no other Chromium brand claims the agent", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe("chrome");
  });

  it("names Opera 'other' rather than mislabelling it Chrome", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
      ),
    ).toBe("other");
  });

  it("does not mistake the legacy EdgeHTML token for modern Edge", () => {
    // Old Edge shipped `Edge/18`, a different engine and a different product.
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763",
      ),
    ).toBe("other");
  });

  it("names Edge on Android and iOS, which spell their token differently", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.42",
      ),
    ).toBe("edge");
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.0.2739.42 Mobile/15E148 Safari/605.1.15",
      ),
    ).toBe("edge");
  });

  it("names Vivaldi 'other' rather than mislabelling it Chrome", () => {
    expect(
      detectBrowserFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Vivaldi/6.9.3447.48",
      ),
    ).toBe("other");
  });

  it("refuses to guess from an agent that names no browser it knows", () => {
    expect(detectBrowserFromUserAgent("")).toBeUndefined();
    expect(detectBrowserFromUserAgent("curl/8.4.0")).toBeUndefined();
    expect(detectBrowserFromUserAgent("Mozilla/5.0 Firefox/130.0")).toBeUndefined();
  });
});
