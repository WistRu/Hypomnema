// @vitest-environment jsdom

import type { TabInstance } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanonicalTabActivation } from "../src/use-canonical-tab-activation";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  executeRelayedTabCommand: vi.fn(),
  fetchCanonicalTabInstances: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  executeRelayedTabCommand: mocks.executeRelayedTabCommand,
  fetchCanonicalTabInstances: mocks.fetchCanonicalTabInstances,
  fetchConnectedTabCommandScopes: mocks.fetchConnectedTabCommandScopes,
}));

vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => ({
    activate: mocks.activate,
    probe: mocks.probe,
  }),
}));

function tab(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    instanceId: 91,
    canonicalTabId: 7,
    installationId: INSTALLATION_ID,
    browserSessionId: BROWSER_SESSION_ID,
    browserTabId: 42,
    url: "https://example.com/live",
    urlNormalized: "https://example.com/live",
    title: "Live tab",
    browser: "chrome",
    windowId: 8,
    index: 2,
    faviconUrl: null,
    active: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 1,
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  mocks.probe.mockResolvedValue({
    available: true,
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    controlWindowId: 8,
    installationId: INSTALLATION_ID,
    pendingUndos: [],
    windows: [],
  });
  mocks.fetchConnectedTabCommandScopes.mockResolvedValue([]);
  mocks.activate.mockResolvedValue({
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    installationId: INSTALLATION_ID,
    tabId: 42,
    windowId: 8,
  });
  mocks.executeRelayedTabCommand.mockResolvedValue({
    kind: "activate-tab",
    tabId: 84,
    windowId: 9,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useCanonicalTabActivation physical targets", () => {
  it("activates the exact supplied instance without resolving its canonical row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const target = tab();
    const rendered = renderHook(() => useCanonicalTabActivation(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    act(() => rendered.result.current.runPhysical(target));

    await waitFor(() => {
      expect(mocks.activate).toHaveBeenCalledWith({
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
        tabId: 42,
      });
    });
    expect(mocks.fetchCanonicalTabInstances).not.toHaveBeenCalled();
    expect(rendered.result.current.errorForPhysical(target.instanceId)).toBeUndefined();

    rendered.unmount();
    queryClient.clear();
  });

  it("relays activation to the exact owning browser scope", async () => {
    const relayScope = {
      browser: "yandex" as const,
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    };
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([relayScope]);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const target = tab({
      browser: "yandex",
      browserSessionId: relayScope.browserSessionId,
      browserTabId: 84,
      installationId: relayScope.installationId,
    });
    const rendered = renderHook(() => useCanonicalTabActivation(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(mocks.fetchConnectedTabCommandScopes).toHaveBeenCalled();
    });
    act(() => rendered.result.current.runPhysical(target));

    await waitFor(() => {
      expect(mocks.executeRelayedTabCommand).toHaveBeenCalledWith({
        ...relayScope,
        command: { kind: "activate-tab", tabId: 84 },
      });
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.fetchCanonicalTabInstances).not.toHaveBeenCalled();

    rendered.unmount();
    queryClient.clear();
  });

  it("associates an unavailable-scope error only with the requested instance", async () => {
    mocks.probe.mockResolvedValue({
      available: false,
      browser: null,
      browserSessionId: null,
      controlWindowId: null,
      installationId: null,
      pendingUndos: [],
      windows: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const target = tab();
    const rendered = renderHook(() => useCanonicalTabActivation(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    act(() => rendered.result.current.runPhysical(target));

    await waitFor(() => {
      expect(rendered.result.current.errorForPhysical(target.instanceId)).toBeInstanceOf(
        Error,
      );
    });
    expect(rendered.result.current.errorForPhysical(target.instanceId + 1)).toBeUndefined();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.executeRelayedTabCommand).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["tab-instances"],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["tabs"] });
    });

    rendered.unmount();
    queryClient.clear();
  });
});
