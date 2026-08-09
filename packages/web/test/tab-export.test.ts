import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { serializeTabs } from "../src/tab-export";

const tab = {
  browser: "chrome",
  index: 2,
  pinned: false,
  title: "A [title]",
  url: "https://example.com/watch?v=one",
  windowId: 7,
} as TabInstance;

describe("tab export", () => {
  it("preserves physical duplicate URLs", () => {
    expect(serializeTabs([tab, tab], "urls")).toBe(`${tab.url}\n${tab.url}`);
  });

  it("escapes Markdown labels", () => {
    expect(serializeTabs([tab], "markdown")).toBe(
      "- [A \\[title\\]](<https://example.com/watch?v=one>)",
    );
  });

  it("emits deterministic compact tab metadata as JSON", () => {
    expect(JSON.parse(serializeTabs([tab], "json"))).toEqual([
      {
        browser: "chrome",
        index: 2,
        pinned: false,
        title: "A [title]",
        url: "https://example.com/watch?v=one",
        windowId: 7,
      },
    ]);
  });
});
