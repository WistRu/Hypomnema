import {
  snapshotTabFaviconUrlMaxLength,
  snapshotTabTitleMaxLength,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  buildIdentityTransitionSnapshots,
  buildSnapshot,
  reconcileCapturedTabUrl,
  toSnapshotTab,
} from "./tab-snapshot";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("toSnapshotTab", () => {
  it("maps the fields accepted by the snapshot endpoint", () => {
    expect(
      toSnapshotTab({
        active: true,
        favIconUrl: "https://example.com/favicon.ico",
        id: 42,
        index: 2,
        lastAccessed: 1_754_000_000_000,
        pinned: false,
        title: "Example",
        url: "https://example.com/page",
        windowId: 7,
      }),
    ).toEqual({
      faviconUrl: "https://example.com/favicon.ico",
      active: true,
      index: 2,
      lastAccessed: 1_754_000_000_000,
      pinned: false,
      tabId: 42,
      title: "Example",
      url: "https://example.com/page",
      windowId: 7,
    });
  });

  it("omits tabs whose URL is not visible to the extension", () => {
    expect(
      buildSnapshot("edge", INSTALLATION_ID, [
        { index: 0, title: "Unavailable", windowId: 1 },
        {
          id: 7,
          index: 1,
          title: "Available",
          url: "https://example.com",
          windowId: 1,
        },
      ]),
    ).toEqual({
      browser: "edge",
      installationId: INSTALLATION_ID,
      tabs: [
        {
          index: 1,
          tabId: 7,
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
      buildSnapshot("chrome", INSTALLATION_ID, [
        {
          favIconUrl: oversizedFavicon,
          id: 8,
          index: 0,
          title: oversizedTitle,
          url: "https://example.com/large-metadata",
          windowId: 1,
        },
        {
          id: 9,
          index: 1,
          title: "Good sibling",
          url: "https://example.com/good",
          windowId: 1,
        },
        {
          id: 10,
          index: 2,
          title: "Bad URL",
          url: "not a url",
          windowId: 1,
        },
      ]),
    ).toEqual({
      browser: "chrome",
      installationId: INSTALLATION_ID,
      tabs: [
        {
          index: 0,
          tabId: 8,
          title: "t".repeat(snapshotTabTitleMaxLength),
          url: "https://example.com/large-metadata",
          windowId: 1,
        },
        {
          index: 1,
          tabId: 9,
          title: "Good sibling",
          url: "https://example.com/good",
          windowId: 1,
        },
      ],
    });
  });

  it("preserves physical duplicate tabs and their browser-local identities", () => {
    const snapshot = buildSnapshot("chrome", INSTALLATION_ID, [
      {
        active: true,
        id: 101,
        index: 0,
        lastAccessed: 1_754_000_000_000,
        pinned: false,
        url: "https://example.com/same",
        windowId: 1,
      },
      {
        active: false,
        id: 202,
        index: 4,
        lastAccessed: 1_753_000_000_000,
        pinned: true,
        url: "https://example.com/same",
        windowId: 2,
      },
    ]);

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        active: true,
        pinned: false,
        tabId: 101,
        url: "https://example.com/same",
      }),
      expect.objectContaining({
        active: false,
        pinned: true,
        tabId: 202,
        url: "https://example.com/same",
      }),
    ]);
  });

  it("drops a URL-bearing record without a native tab ID from a modern snapshot", () => {
    expect(
      buildSnapshot("chrome", INSTALLATION_ID, [
        {
          index: 0,
          url: "https://example.com/not-yet-identifiable",
          windowId: 1,
        },
        {
          id: 302,
          index: 1,
          url: "https://example.com/identified",
          windowId: 1,
        },
      ]).tabs.map(({ tabId }) => tabId),
    ).toEqual([302]);
  });

  it("uses a pending URL while a newly-created tab has no committed URL", () => {
    expect(
      buildSnapshot("chrome", INSTALLATION_ID, [
        {
          active: false,
          id: 303,
          index: 0,
          lastAccessed: 1_754_000_000_000,
          pendingUrl: "https://example.com/loading",
          pinned: false,
          windowId: 1,
        },
      ]).tabs,
    ).toEqual([
      expect.objectContaining({
        tabId: 303,
        url: "https://example.com/loading",
      }),
    ]);
  });

  it("prefers the pending URL over a stale committed URL during navigation", () => {
    expect(
      buildSnapshot("chrome", INSTALLATION_ID, [
        {
          active: true,
          id: 304,
          index: 0,
          pendingUrl: "https://www.youtube.com/watch?v=second-video",
          title: "Second video - YouTube",
          url: "https://www.youtube.com/watch?v=first-video",
          windowId: 1,
        },
      ]).tabs,
    ).toEqual([
      expect.objectContaining({
        tabId: 304,
        title: "Second video - YouTube",
        url: "https://www.youtube.com/watch?v=second-video",
      }),
    ]);
  });

  it("accepts a captured redirect after the current snapshot observes the redirected URL", () => {
    const snapshot = buildSnapshot("chrome", INSTALLATION_ID, [
      {
        active: true,
        id: 404,
        index: 2,
        lastAccessed: 1_754_000_000_000,
        pinned: false,
        url: "https://example.com/after",
        windowId: 7,
      },
    ]);

    expect(
      reconcileCapturedTabUrl(snapshot, {
        id: 404,
        index: 2,
        url: "https://example.com/after",
        windowId: 7,
      }, {
        id: 404,
        index: 2,
        url: "https://example.com/after",
        windowId: 7,
      }),
    ).toBe(true);

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        active: true,
        pinned: false,
        tabId: 404,
        url: "https://example.com/after",
      }),
    ]);
  });

  it("does not resurrect a captured tab absent from the current snapshot", () => {
    const snapshot = buildSnapshot("chrome", INSTALLATION_ID, []);

    expect(
      reconcileCapturedTabUrl(snapshot, {
        id: 405,
        index: 2,
        url: "https://example.com/already-closed",
        windowId: 7,
      }, undefined),
    ).toBe(false);
    expect(snapshot.tabs).toEqual([]);
  });

  it("does not attach captured content after the same native tab navigates elsewhere", () => {
    const snapshot = buildSnapshot("chrome", INSTALLATION_ID, [
      {
        id: 406,
        index: 2,
        url: "https://example.com/current-page",
        windowId: 7,
      },
    ]);

    expect(
      reconcileCapturedTabUrl(snapshot, {
        id: 406,
        index: 2,
        url: "https://example.com/captured-old-page",
        windowId: 7,
      }, {
        id: 406,
        index: 2,
        url: "https://example.com/current-page",
        windowId: 7,
      }),
    ).toBe(false);
    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        tabId: 406,
        url: "https://example.com/current-page",
      }),
    ]);
  });

  it("rejects captured content while the same native tab has a pending navigation", () => {
    const snapshot = buildSnapshot("chrome", INSTALLATION_ID, [
      {
        id: 407,
        index: 2,
        url: "https://example.com/captured-page",
        windowId: 7,
      },
    ]);

    expect(
      reconcileCapturedTabUrl(snapshot, {
        id: 407,
        index: 2,
        url: "https://example.com/captured-page",
        windowId: 7,
      }, {
        id: 407,
        index: 2,
        pendingUrl: "https://example.com/loading-next-page",
        url: "https://example.com/captured-page",
        windowId: 7,
      }),
    ).toBe(false);
  });
});

describe("buildIdentityTransitionSnapshots", () => {
  const tabs = [
    {
      id: 501,
      index: 0,
      title: "Example",
      url: "https://example.com",
      windowId: 1,
    },
  ];

  it("closes the previous identity before opening the new identity", () => {
    expect(
      buildIdentityTransitionSnapshots(
        "chrome",
        "edge",
        INSTALLATION_ID,
        tabs,
      ),
    ).toEqual([
      { browser: "chrome", installationId: INSTALLATION_ID, tabs: [] },
      {
        browser: "edge",
        installationId: INSTALLATION_ID,
        tabs: [
          {
            index: 0,
            tabId: 501,
            title: "Example",
            url: "https://example.com",
            windowId: 1,
          },
        ],
      },
    ]);
  });

  it("only opens the selected identity on first configuration", () => {
    expect(
      buildIdentityTransitionSnapshots(
        undefined,
        "yandex",
        INSTALLATION_ID,
        tabs,
      ),
    ).toEqual([
      {
        browser: "yandex",
        installationId: INSTALLATION_ID,
        tabs: [
          {
            index: 0,
            tabId: 501,
            title: "Example",
            url: "https://example.com",
            windowId: 1,
          },
        ],
      },
    ]);
  });
});
