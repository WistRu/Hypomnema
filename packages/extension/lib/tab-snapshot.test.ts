import {
  snapshotTabFaviconUrlMaxLength,
  snapshotTabTitleMaxLength,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  buildIdentityTransitionSnapshots,
  buildSnapshot,
  toSnapshotTab,
} from "./tab-snapshot";

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

  it("normalizes browser-owned metadata without losing valid sibling tabs", () => {
    const oversizedFavicon = `data:image/png;base64,${"a".repeat(
      snapshotTabFaviconUrlMaxLength,
    )}`;
    const oversizedTitle = "t".repeat(snapshotTabTitleMaxLength + 100);

    expect(
      buildSnapshot("chrome", [
        {
          favIconUrl: oversizedFavicon,
          index: 0,
          title: oversizedTitle,
          url: "https://example.com/large-metadata",
          windowId: 1,
        },
        {
          index: 1,
          title: "Good sibling",
          url: "https://example.com/good",
          windowId: 1,
        },
        {
          index: 2,
          title: "Bad URL",
          url: "not a url",
          windowId: 1,
        },
      ]),
    ).toEqual({
      browser: "chrome",
      tabs: [
        {
          index: 0,
          title: "t".repeat(snapshotTabTitleMaxLength),
          url: "https://example.com/large-metadata",
          windowId: 1,
        },
        {
          index: 1,
          title: "Good sibling",
          url: "https://example.com/good",
          windowId: 1,
        },
      ],
    });
  });
});

describe("buildIdentityTransitionSnapshots", () => {
  const tabs = [
    { index: 0, title: "Example", url: "https://example.com", windowId: 1 },
  ];

  it("closes the previous identity before opening the new identity", () => {
    expect(buildIdentityTransitionSnapshots("chrome", "edge", tabs)).toEqual([
      { browser: "chrome", tabs: [] },
      {
        browser: "edge",
        tabs: [
          {
            index: 0,
            title: "Example",
            url: "https://example.com",
            windowId: 1,
          },
        ],
      },
    ]);
  });

  it("only opens the selected identity on first configuration", () => {
    expect(buildIdentityTransitionSnapshots(undefined, "yandex", tabs)).toEqual([
      {
        browser: "yandex",
        tabs: [
          {
            index: 0,
            title: "Example",
            url: "https://example.com",
            windowId: 1,
          },
        ],
      },
    ]);
  });
});
