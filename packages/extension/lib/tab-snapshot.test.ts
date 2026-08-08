import { describe, expect, it } from "vitest";

import { buildSnapshot, toSnapshotTab } from "./tab-snapshot";

describe("toSnapshotTab", () => {
  it("maps the fields accepted by the snapshot endpoint", () => {
    expect(
      toSnapshotTab({
        favIconUrl: "https://example.com/favicon.ico",
        index: 2,
        title: "Example",
        url: "https://example.com/page",
        windowId: 7,
      }),
    ).toEqual({
      faviconUrl: "https://example.com/favicon.ico",
      index: 2,
      title: "Example",
      url: "https://example.com/page",
      windowId: 7,
    });
  });

  it("omits tabs whose URL is not visible to the extension", () => {
    expect(
      buildSnapshot("edge", [
        { index: 0, title: "Unavailable", windowId: 1 },
        {
          index: 1,
          title: "Available",
          url: "https://example.com",
          windowId: 1,
        },
      ]),
    ).toEqual({
      browser: "edge",
      tabs: [
        {
          index: 1,
          title: "Available",
          url: "https://example.com",
          windowId: 1,
        },
      ],
    });
  });
});
