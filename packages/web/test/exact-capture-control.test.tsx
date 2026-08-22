// @vitest-environment jsdom

import {
  tabCommandRelayProtocolVersion,
  type TabCommandRelayConnectedScope,
  type TabInstance,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabCommandRelayClientError } from "../src/api";
import { ExactCaptureControl } from "../src/ExactCaptureControl";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  executeRelayedTabCommand: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  executeRelayedTabCommand: mocks.executeRelayedTabCommand,
  fetchConnectedTabCommandScopes: mocks.fetchConnectedTabCommandScopes,
}));

vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => ({ probe: mocks.probe }),
}));

const SESSION_A = "223e4567-e89b-42d3-a456-426614174000";
const SESSION_B = "323e4567-e89b-42d3-a456-426614174000";
const INSTALLATION_A = "123e4567-e89b-42d3-a456-426614174000";
const INSTALLATION_B = "423e4567-e89b-42d3-a456-426614174000";

function instance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: SESSION_A,
    browserTabId: 41,
    canonicalTabId: 7,
    discarded: false,
    duplicateGroupSize: 2,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    foregroundTimeMs: 0,
    importance: "medium",
    index: 1,
    installationId: INSTALLATION_A,
    instanceId: 11,
    instanceRevision: 3,
    lastAccessed: 100,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Same page",
    url: "https://example.com/article",
    urlNormalized: "https://example.com/article",
    windowId: 2,
    ...overrides,
  };
}

function scope(
  overrides: Partial<TabCommandRelayConnectedScope> = {},
): TabCommandRelayConnectedScope {
  return {
    browser: "chrome",
    browserSessionId: SESSION_A,
    connectedAt: "2026-08-13T08:00:00.000Z",
    installationId: INSTALLATION_A,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    protocolVersion: tabCommandRelayProtocolVersion,
    ...overrides,
  };
}

function renderControl(
  instances: TabInstance[],
  options: {
    locale?: "en" | "ru";
    onCaptured?: ReturnType<typeof vi.fn>;
    onCaptureReconciled?: ReturnType<typeof vi.fn>;
    onCaptureUnchanged?: ReturnType<typeof vi.fn>;
    refetchInstances?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(["tab", 7], { id: 7 });
  const refetchInstances = options.refetchInstances ?? vi.fn().mockResolvedValue({
    data: instances,
    isError: false,
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={options.locale ?? "en"}>
        <ExactCaptureControl
          canonicalTabId={7}
          detail={{ id: 7, content: null }}
          instances={instances}
          instancesPending={false}
          onCaptured={options.onCaptured}
          onCaptureReconciled={options.onCaptureReconciled}
          onCaptureUnchanged={options.onCaptureUnchanged}
          refetchInstances={refetchInstances}
          refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: null }, isError: false })}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, refetchInstances };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Drawer exact capture control", () => {
  it("requires an explicit radio choice among same-URL copies and sends only its exact target", async () => {
    mocks.probe.mockResolvedValue({
      available: false,
      browser: null,
      browserSessionId: null,
      controlWindowId: null,
      installationId: null,
      pendingUndos: [],
      windows: [],
    });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([
      scope(),
      scope({ browserSessionId: SESSION_B, installationId: INSTALLATION_B }),
    ]);
    const second = instance({
      browserSessionId: SESSION_B,
      browserTabId: 52,
      firstSeenAt: "2026-08-13T08:03:00.000Z",
      installationId: INSTALLATION_B,
      instanceId: 12,
      instanceRevision: 8,
      windowId: 3,
    });
    mocks.executeRelayedTabCommand.mockImplementation(async (request) => ({
      kind: "capture-tab-content",
      outcome: {
        receipt: {
          browserTabId: 52,
          canonicalTabId: 7,
          capturedUrl: second.url,
          contentRevision: 2,
          extractedAt: "2026-08-13T08:04:00.000Z",
          firstSeenAt: second.firstSeenAt,
          instanceId: second.instanceId,
          instanceRevision: second.instanceRevision,
          logicalPageId: 17,
        },
        status: "captured",
      },
      target: request.command.target,
    }));
    renderControl([instance(), second]);

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole("button", { name: "Capture page" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledWith({
      browser: "chrome",
      browserSessionId: SESSION_B,
      command: {
        kind: "capture-tab-content",
        target: {
          expectedFirstSeenAt: second.firstSeenAt,
          expectedInstanceRevision: 8,
          expectedUrl: second.url,
          instanceId: 12,
          tabId: 52,
        },
      },
      installationId: INSTALLATION_B,
    });
  });

  it("visibly preselects one selectable copy", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    renderControl([instance()]);

    const radio = await screen.findByRole("radio");
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/window 2, tab 41/i)).toBeTruthy();
  });

  it("invalidates an exact selection when the same instance id changes revision", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const view = renderControl([instance()]);
    const radio = await screen.findByRole("radio");
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));

    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <I18nProvider initialLocale="en">
          <ExactCaptureControl
            canonicalTabId={7}
            detail={{ id: 7, content: null }}
            instances={[instance({ instanceRevision: 4 })]}
            instancesPending={false}
            refetchInstances={view.refetchInstances}
            refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: null }, isError: false })}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("The selected copy changed. Refresh and select it again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Capture page" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.executeRelayedTabCommand).not.toHaveBeenCalled();
  });

  it("requires manual re-selection when an unknown outcome refresh shows no new revision", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockRejectedValue(
      new TabCommandRelayClientError("lost response", {
        code: "EXTENSION_DISCONNECTED",
        outcome: "unknown",
      }),
    );
    const onCaptureUnchanged = vi.fn();
    const { refetchInstances } = renderControl([instance()], { onCaptureUnchanged });
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);

    expect(await screen.findByText(/Capture outcome is unknown/)).toBeTruthy();
    expect((capture as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
    const refresh = screen.getByRole("button", { name: "Refresh copies" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(refetchInstances).toHaveBeenCalledOnce());
    await waitFor(() => expect(onCaptureUnchanged).toHaveBeenCalledOnce());
    expect((capture as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("radio"));
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
  });

  it("keeps capture blocked when explicit refresh fails", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const refetchInstances = vi.fn().mockResolvedValue({ isError: true });
    renderControl([instance()], { refetchInstances });
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture page" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));

    expect(await screen.findByText("TabHub could not refresh capture availability.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Capture page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not unblock from a success flag that omits a fresh instance snapshot", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const refetchInstances = vi.fn().mockResolvedValue({ isError: false });
    renderControl([instance()], { refetchInstances });
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));

    expect(await screen.findByText("TabHub could not refresh capture availability.")).toBeTruthy();
    expect((capture as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not briefly re-enable a cached target while a changed fresh snapshot awaits rendering", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const refetchInstances = vi.fn().mockResolvedValue({
      data: [instance({ instanceRevision: 4 })],
      isError: false,
    });
    const view = renderControl([instance()], { refetchInstances });
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));

    await waitFor(() => expect(refetchInstances).toHaveBeenCalledOnce());
    expect((capture as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.executeRelayedTabCommand).not.toHaveBeenCalled();

    const refreshed = instance({ instanceRevision: 4 });
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <I18nProvider initialLocale="en">
          <ExactCaptureControl
            canonicalTabId={7}
            detail={{ id: 7, content: null }}
            instances={[refreshed]}
            instancesPending={false}
            refetchInstances={refetchInstances}
            refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: null }, isError: false })}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    mocks.executeRelayedTabCommand.mockImplementation(async (request) => ({
      kind: "capture-tab-content",
      outcome: {
        receipt: {
          browserTabId: 41,
          canonicalTabId: 7,
          capturedUrl: refreshed.url,
          contentRevision: 2,
          extractedAt: "2026-08-13T08:05:00.000Z",
          firstSeenAt: refreshed.firstSeenAt,
          instanceId: refreshed.instanceId,
          instanceRevision: 4,
          logicalPageId: 17,
        },
        status: "captured",
      },
      target: request.command.target,
    }));
    fireEvent.click(capture);
    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          target: expect.objectContaining({ expectedInstanceRevision: 4 }),
        }),
      }),
    );
  });

  it("does not let a failed best-effort page probe block fresh relay capture availability", async () => {
    mocks.probe.mockRejectedValue(new Error("bridge unavailable"));
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    renderControl([instance()]);
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));

    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.probe).toHaveBeenCalled();
  });

  it("waits for the fresh content revision after an unknown capture before unblocking", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockRejectedValue(
      new TabCommandRelayClientError("lost response", {
        code: "EXTENSION_DISCONNECTED",
        outcome: "unknown",
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const refetchInstances = vi.fn().mockResolvedValue({ data: [instance()], isError: false });
    const refetchTabDetail = vi.fn().mockResolvedValue({
      data: { id: 7, content: { contentRevision: 2 } },
      isError: false,
    });
    const onCaptureReconciled = vi.fn();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <ExactCaptureControl
            canonicalTabId={7}
            detail={{ id: 7, content: { contentRevision: 1 } }}
            instances={[instance()]}
            instancesPending={false}
            onCaptureReconciled={onCaptureReconciled}
            refetchInstances={refetchInstances}
            refetchTabDetail={refetchTabDetail}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    await screen.findByText(/Capture outcome is unknown/);
    const refresh = screen.getByRole("button", { name: "Refresh copies" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(refetchTabDetail).toHaveBeenCalledOnce());
    expect((capture as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <ExactCaptureControl
            canonicalTabId={7}
            detail={{ id: 7, content: { contentRevision: 2 } }}
            instances={[instance()]}
            instancesPending={false}
            onCaptureReconciled={onCaptureReconciled}
            refetchInstances={refetchInstances}
            refetchTabDetail={refetchTabDetail}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(onCaptureReconciled).toHaveBeenCalledWith({
      contentRevision: 2,
      previousContentRevision: 1,
    }));
    expect((capture as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
  });

  it("keeps refresh blocked when tab detail belongs to another canonical page", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const refetchTabDetail = vi.fn().mockResolvedValue({
      data: { id: 8, content: null },
      isError: false,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <ExactCaptureControl
            canonicalTabId={7}
            detail={{ id: 7, content: null }}
            instances={[instance()]}
            instancesPending={false}
            refetchInstances={() => Promise.resolve({ data: [instance()], isError: false })}
            refetchTabDetail={refetchTabDetail}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));
    expect(await screen.findByText("TabHub could not refresh capture availability.")).toBeTruthy();
    expect((capture as HTMLButtonElement).disabled).toBe(true);
  });

  it("fences duplicate primary clicks before React can render pending state", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    let release: ((value: unknown) => void) | undefined;
    mocks.executeRelayedTabCommand.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderControl([instance()]);
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(capture);
    fireEvent.click(capture);

    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    release?.({
      kind: "capture-tab-content",
      outcome: {
        receipt: {
          browserTabId: 41,
          canonicalTabId: 7,
          capturedUrl: instance().url,
          contentRevision: 2,
          extractedAt: "2026-08-13T08:05:00.000Z",
          firstSeenAt: instance().firstSeenAt,
          instanceId: 11,
          instanceRevision: 3,
          logicalPageId: 17,
        },
        status: "captured",
      },
      target: {
        expectedFirstSeenAt: instance().firstSeenAt,
        expectedInstanceRevision: 3,
        expectedUrl: instance().url,
        instanceId: 11,
        tabId: 41,
      },
    });
  });

  it("reports a runtime page-summary capability race distinctly in Russian", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockRejectedValue(
      new TabCommandRelayClientError("disabled", {
        code: "PAGE_SUMMARY_CAPTURE_UNAVAILABLE",
        outcome: "not-sent",
      }),
    );
    const onCaptureFailed = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="ru">
          <ExactCaptureControl
            actionLabel="Сохранить и создать сводку"
            canonicalTabId={7}
            detail={{ id: 7, content: null }}
            instances={[instance()]}
            instancesPending={false}
            onCaptureFailed={onCaptureFailed}
            refetchInstances={() => Promise.resolve({ data: [instance()], isError: false })}
            refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: null }, isError: false })}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const capture = await screen.findByRole("button", { name: "Сохранить и создать сводку" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);

    expect(await screen.findByText(/было отключено во время запуска действия/)).toBeTruthy();
    expect(onCaptureFailed).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("PAGE_SUMMARY_CAPTURE_UNAVAILABLE");
  });

  it("does not publish a late receipt after the control unmounts", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    let release: ((value: unknown) => void) | undefined;
    mocks.executeRelayedTabCommand.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const onCaptured = vi.fn();
    const view = renderControl([instance()], { onCaptured });
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    view.unmount();

    release?.({
      kind: "capture-tab-content",
      outcome: {
        receipt: {
          browserTabId: 41,
          canonicalTabId: 7,
          capturedUrl: instance().url,
          contentRevision: 2,
          extractedAt: "2026-08-13T08:05:00.000Z",
          firstSeenAt: instance().firstSeenAt,
          instanceId: 11,
          instanceRevision: 3,
          logicalPageId: 17,
        },
        status: "captured",
      },
      target: {
        expectedFirstSeenAt: instance().firstSeenAt,
        expectedInstanceRevision: 3,
        expectedUrl: instance().url,
        instanceId: 11,
        tabId: 41,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onCaptured).not.toHaveBeenCalled();
  });

  it("still publishes capture after React StrictMode effect replay", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue({
      kind: "capture-tab-content",
      outcome: {
        receipt: {
          browserTabId: 41,
          canonicalTabId: 7,
          capturedUrl: instance().url,
          contentRevision: 2,
          extractedAt: "2026-08-13T08:05:00.000Z",
          firstSeenAt: instance().firstSeenAt,
          instanceId: 11,
          instanceRevision: 3,
          logicalPageId: 17,
        },
        status: "captured",
      },
      target: {
        expectedFirstSeenAt: instance().firstSeenAt,
        expectedInstanceRevision: 3,
        expectedUrl: instance().url,
        instanceId: 11,
        tabId: 41,
      },
    });
    const onCaptured = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <ExactCaptureControl
              canonicalTabId={7}
              detail={{ id: 7, content: null }}
              instances={[instance()]}
              instancesPending={false}
              onCaptured={onCaptured}
              refetchInstances={() => Promise.resolve({ data: [instance()], isError: false })}
              refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: null }, isError: false })}
            />
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    const capture = await screen.findByRole("button", { name: "Capture page" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);

    await waitFor(() => expect(onCaptured).toHaveBeenCalledOnce());
  });

  it("renders Russian labels and unavailable reasons without English leakage", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([]);
    renderControl([instance()], { locale: "ru" });

    expect(await screen.findByRole("group", { name: "Открытая копия для сохранения" })).toBeTruthy();
    expect(screen.getByText("Эта сессия браузера не подключена.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Сохранить страницу" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Capture page");
  });
});
