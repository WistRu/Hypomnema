import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/i18n", () => ({
  useI18n: () => ({
    formatNumber: (value: number) => String(value),
    formatDuration: (value: number) => `${value}ms`,
    t: (key: string) => key,
  }),
}));

import { OpenTabRow } from "../src/OpenTabsView";

const tab: TabInstance = {
  active: false,
  audible: false,
  browser: "yandex",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  browserTabId: 107,
  canonicalTabId: 17,
  discarded: false,
  duplicateGroupSize: 1,
  faviconUrl: null,
  firstSeenAt: "2026-08-10T00:00:00.000Z",
  foregroundTimeMs: 0,
  engagedTimeMs: 0,
  importance: "medium",
  index: 2,
  installationId: "123e4567-e89b-42d3-a456-426614174000",
  instanceId: 27,
  lastAccessed: null,
  lastSeenAt: "2026-08-10T00:01:00.000Z",
  muted: false,
  pinned: true,
  status: "inbox",
  summary: null,
  tagPaths: [],
  title: "Pinned exact occurrence",
  url: "https://example.com/exact",
  urlNormalized: "https://example.com/exact",
  windowId: 9,
};

describe("OpenTabRow middle click", () => {
  it("closes the exact physical occurrence, including a pinned tab", () => {
    const onActivateTab = vi.fn();
    const onMiddleClose = vi.fn();
    const row = OpenTabRow({
      activation: {
        kind: "ready",
        route: "relay",
        target: {
          browser: tab.browser,
          browserSessionId: tab.browserSessionId!,
          installationId: tab.installationId,
          tabId: tab.browserTabId!,
        },
      },
      tab,
      onActivateTab,
      onMiddleClose,
      onSelectCanonicalTab: vi.fn(),
    });
    const event = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    row.props.onAuxClick(event);

    expect(onMiddleClose).toHaveBeenCalledWith(tab);
    expect(onActivateTab).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
