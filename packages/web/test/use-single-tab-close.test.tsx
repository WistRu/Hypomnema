// @vitest-environment jsdom

import {
  tabCommandRelayProtocolVersion,
  type TabInstance,
  type TabListResponse,
} from "@tabhub/shared";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { useSingleTabClose } from "../src/use-single-tab-close";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchConnectedTabCommandScopes: mocks.fetchConnectedTabCommandScopes,
}));

vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => ({
    command: mocks.command,
    probe: mocks.probe,
  }),
}));

function tab(instanceId: number, canonicalTabId = 7): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    browserTabId: 40 + instanceId,
    canonicalTabId,
    discarded: false,
    duplicateGroupSize: 2,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    foregroundTimeMs: 0,
    importance: 0,
    index: instanceId - 1,
    installationId: INSTALLATION_ID,
    instanceId,
    lastAccessed: null,
    lastSeenAt: "2026-08-11T00:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: `Physical copy ${instanceId}`,
    url: `https://example.com/page?copy=${instanceId}`,
    urlNormalized: "https://example.com/page",
    windowId: 4,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      </QueryClientProvider>
    );
  };
}

function tabList(
  openInstanceCount: number,
  openEngagedTimeMs = 0,
  openForegroundTimeMs = 0,
  engagedTimeMs = 0,
  foregroundTimeMs = 0,
): TabListResponse {
  return {
    items: [
      {
        browser: "chrome",
        closedAt: null,
        faviconUrl: null,
        firstSeenAt: "2026-08-11T00:00:00.000Z",
        id: 7,
        importance: 0,
        index: 0,
        isOpen: true,
        lastSeenAt: "2026-08-11T00:01:00.000Z",
        engagedTimeMs,
        foregroundTimeMs,
        openEngagedTimeMs,
        openForegroundTimeMs,
        openInstanceCount,
        status: "inbox",
        summary: null,
        tagPaths: [],
        title: "Canonical page",
        url: "https://example.com/page",
        urlNormalized: "https://example.com/page",
        windowId: 4,
      },
    ],
    page: 1,
    pageSize: 50,
    total: 1,
  };
}

beforeEach(() => {
  mocks.command.mockReset();
  mocks.probe.mockResolvedValue({
    available: true,
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    commandProtocolVersion: tabCommandRelayProtocolVersion,
    controlWindowId: 4,
    installationId: INSTALLATION_ID,
    pendingUndos: [],
    windows: [],
  });
  mocks.fetchConnectedTabCommandScopes.mockResolvedValue([]);
  mocks.command
    .mockResolvedValueOnce({
      browser: "chrome",
      browserSessionId: BROWSER_SESSION_ID,
      installationId: INSTALLATION_ID,
      result: {
        candidateTabIds: [41],
        expiresAt: 1_800_000_000_000,
        kind: "close-preview",
        previewId: "323e4567-e89b-42d3-a456-426614174000",
        requested: 1,
        skipped: [],
      },
    })
    .mockResolvedValueOnce({
      browser: "chrome",
      browserSessionId: BROWSER_SESSION_ID,
      installationId: INSTALLATION_ID,
      result: {
        failed: [],
        kind: "close",
        requested: 1,
        skipped: [],
        succeededTabIds: [41],
        undo: null,
      },
    });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSingleTabClose Library feedback", () => {
  it("removes a closed copy and refreshes authoritative page activity", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const closedCopy = {
      ...tab(1),
      engagedTimeMs: 2_000,
      foregroundTimeMs: 5_000,
    };
    const remainingCopy = {
      ...tab(2),
      engagedTimeMs: 3_000,
      foregroundTimeMs: 7_000,
    };
    const libraryKey = [
      "tab-instances",
      "library",
      { openState: "all" },
    ] as const;
    const drawerKey = [
      "tab-instances",
      { canonicalTabId: closedCopy.canonicalTabId },
    ] as const;
    const tabsKey = [
      "tabs",
      { duplicatesOnly: false, openState: "all" },
    ] as const;
    const duplicateTabsKey = [
      "tabs",
      { duplicatesOnly: true, openState: "open" },
    ] as const;
    const staleLibraryFetch = vi
      .fn()
      .mockResolvedValue([closedCopy, remainingCopy]);
    const authoritativeTabsFetch = vi
      .fn()
      .mockResolvedValue(tabList(1, 3_000, 7_000, 5_500, 13_000));
    const detailKey = ["tab", closedCopy.canonicalTabId] as const;
    const authoritativeDetailFetch = vi.fn().mockResolvedValue({
      engagedTimeMs: 5_500,
      foregroundTimeMs: 13_000,
    });
    queryClient.setQueryData(libraryKey, [closedCopy, remainingCopy]);
    queryClient.setQueryData(drawerKey, [closedCopy, remainingCopy]);
    queryClient.setQueryData(tabsKey, tabList(2, 5_000, 12_000, 4_000, 11_000));
    queryClient.setQueryData(duplicateTabsKey, tabList(3, 5_000, 12_000));
    queryClient.setQueryData(detailKey, {
      engagedTimeMs: 4_000,
      foregroundTimeMs: 11_000,
    });
    const rendered = renderHook(
      () => {
        const close = useSingleTabClose();
        useQuery({
          queryFn: staleLibraryFetch,
          queryKey: libraryKey,
          staleTime: Infinity,
        });
        useQuery({
          queryFn: authoritativeTabsFetch,
          queryKey: tabsKey,
          staleTime: Infinity,
        });
        useQuery({
          queryFn: authoritativeDetailFetch,
          queryKey: detailKey,
          staleTime: Infinity,
        });
        return close;
      },
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    act(() => rendered.result.current.closePhysical(closedCopy));

    await waitFor(() => {
      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(queryClient.isMutating()).toBe(0);
    });
    expect(staleLibraryFetch).not.toHaveBeenCalled();
    expect(authoritativeTabsFetch).toHaveBeenCalledOnce();
    expect(authoritativeDetailFetch).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(libraryKey)).toEqual([remainingCopy]);
    expect(queryClient.getQueryData(drawerKey)).toEqual([remainingCopy]);
    expect(
      queryClient.getQueryData<TabListResponse>(tabsKey)?.items[0],
    ).toMatchObject({
      isOpen: true,
      openEngagedTimeMs: 3_000,
      openForegroundTimeMs: 7_000,
      openInstanceCount: 1,
      engagedTimeMs: 5_500,
      foregroundTimeMs: 13_000,
    });
    expect(queryClient.getQueryData(detailKey)).toEqual({
      engagedTimeMs: 5_500,
      foregroundTimeMs: 13_000,
    });
    expect(
      queryClient.getQueryData<TabListResponse>(duplicateTabsKey),
    ).toMatchObject({
      items: [],
      total: 0,
    });

    rendered.unmount();
    queryClient.clear();
  });

  it("marks a canonical Library row closed when its sole copy closes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const closedCopy = { ...tab(1), duplicateGroupSize: 1 };
    const libraryKey = [
      "tab-instances",
      "library",
      { openState: "all" },
    ] as const;
    const tabsKey = [
      "tabs",
      { duplicatesOnly: false, openState: "all" },
    ] as const;
    queryClient.setQueryData(libraryKey, [closedCopy]);
    queryClient.setQueryData(tabsKey, tabList(1));
    const rendered = renderHook(() => useSingleTabClose(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    act(() => rendered.result.current.closePhysical(closedCopy));

    await waitFor(() => {
      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(queryClient.isMutating()).toBe(0);
    });
    expect(queryClient.getQueryData(libraryKey)).toEqual([]);
    expect(
      queryClient.getQueryData<TabListResponse>(tabsKey)?.items[0],
    ).toMatchObject({
      closedAt: expect.any(String),
      index: null,
      isOpen: false,
      openInstanceCount: 0,
      windowId: null,
    });

    rendered.unmount();
    queryClient.clear();
  });
});
