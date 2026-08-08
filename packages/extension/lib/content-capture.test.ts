import { describe, expect, it } from "vitest";

import {
  captureEligibleTabs,
  finalizeExtractedPage,
  MAX_HTML_EXCERPT_LENGTH,
  MAX_TEXT_LENGTH,
} from "./content-capture";

describe("captureEligibleTabs", () => {
  it("captures eligible pages while skipping restricted and unavailable tabs", async () => {
    const result = await captureEligibleTabs(
      [
        {
          id: 1,
          index: 0,
          url: "https://example.com/article",
          windowId: 1,
        },
        { id: 2, index: 1, url: "chrome://settings", windowId: 1 },
        {
          id: 3,
          index: 2,
          url: "https://chromewebstore.google.com/detail/example",
          windowId: 1,
        },
        {
          discarded: true,
          id: 4,
          index: 3,
          url: "https://example.com/discarded",
          windowId: 1,
        },
      ],
      async (tabId) => {
        if (tabId === 3) {
          throw new Error("Cannot access this page");
        }

        return {
          htmlExcerpt: "<p>Article text</p>",
          text: "Article text",
          url: "https://example.com/article",
        };
      },
    );

    expect(result.requested).toBe(4);
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0]?.page.text).toBe("Article text");
    expect(result.skipped).toBe(3);
  });

  it("does not treat one rejected injection as a batch failure", async () => {
    const result = await captureEligibleTabs(
      [
        { id: 1, index: 0, url: "https://one.example", windowId: 1 },
        { id: 2, index: 1, url: "https://two.example", windowId: 1 },
      ],
      async (tabId) => {
        if (tabId === 1) {
          throw new Error("Tab closed during capture");
        }

        return {
          htmlExcerpt: "<p>Two</p>",
          text: "Two",
          url: "https://two.example",
        };
      },
    );

    expect(result.captured).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});

describe("finalizeExtractedPage", () => {
  it("falls back to body text and cloned body HTML when Readability is empty", () => {
    expect(
      finalizeExtractedPage({
        fallbackHtml: "<main>Fallback</main>",
        fallbackText: "  Fallback text  ",
        readabilityHtml: " ",
        readabilityText: "\n",
        url: "https://example.com",
      }),
    ).toEqual({
      htmlExcerpt: "<main>Fallback</main>",
      text: "Fallback text",
      url: "https://example.com",
    });
  });

  it("clips extracted values to the shared ingest limits", () => {
    const result = finalizeExtractedPage({
      fallbackHtml: "",
      fallbackText: "",
      readabilityHtml: "h".repeat(MAX_HTML_EXCERPT_LENGTH + 10),
      readabilityText: "t".repeat(MAX_TEXT_LENGTH + 10),
      url: "https://example.com",
    });

    expect(result.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(result.htmlExcerpt).toHaveLength(MAX_HTML_EXCERPT_LENGTH);
  });
});
