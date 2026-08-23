/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { PairBrowser } from "../src/PairBrowser";

const mocks = vi.hoisted(() => ({
  createLocalPairingChallenge: vi.fn(),
  fetchFeatureFlags: vi.fn(),
  pair: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));
vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => ({ pair: mocks.pair, probe: mocks.probe }),
}));

const installationId = "122e4567-e89b-42d3-a456-426614174000";
const extensionOrigin = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";

function probeData(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    browser: "chrome",
    browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
    commandProtocolVersion: 5,
    controlWindowId: 2,
    extensionOrigin,
    installationId,
    pendingUndos: [],
    windows: [],
    ...overrides,
  };
}

function renderPair(variant: "banner" | "panel") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <PairBrowser variant={variant} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchFeatureFlags.mockResolvedValue({ context: true, logicalImportance: false });
  mocks.createLocalPairingChallenge.mockResolvedValue({
    challengeId: "322e4567-e89b-42d3-a456-426614174000",
    code: "PAIRING-CODE-DOES-NOT-ENTER-A-URL-1234567890",
    expiresAt: "2026-08-23T10:00:00.000Z",
  });
});
afterEach(() => cleanup());

describe("PairBrowser banner", () => {
  it("offers pairing when the extension says it is unpaired", async () => {
    mocks.probe.mockResolvedValue(probeData({ paired: false }));
    mocks.pair.mockResolvedValue({ installationId, paired: true });
    renderPair("banner");

    expect(
      await screen.findByText("This browser is not connected to personal context yet."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pair this browser for personal context" }));

    await waitFor(() => expect(mocks.pair).toHaveBeenCalledOnce());
    expect(await screen.findByText("This browser is paired.")).toBeTruthy();
  });

  it("stays silent once the extension is paired", async () => {
    mocks.probe.mockResolvedValue(probeData({ paired: true }));
    const view = renderPair("banner");

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });

  it("stays silent when the extension is too old to say either way", async () => {
    // No `paired` field at all: nagging an already paired browser on a guess
    // is worse than staying quiet, and the panel still offers the control.
    mocks.probe.mockResolvedValue(probeData());
    const view = renderPair("banner");

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });

  it("stays silent when no extension answers at all", async () => {
    mocks.probe.mockResolvedValue({
      available: false,
      browser: null,
      browserSessionId: null,
      controlWindowId: null,
      installationId: null,
      pendingUndos: [],
      windows: [],
    });
    const view = renderPair("banner");

    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });
});

describe("PairBrowser panel", () => {
  it("still offers the control when the extension cannot report pairing", async () => {
    mocks.probe.mockResolvedValue(probeData());
    renderPair("panel");

    expect(
      await screen.findByRole("button", { name: "Pair this browser for personal context" }),
    ).toBeTruthy();
    expect(
      screen.getByText("One-time step for this browser. Pairing does not expire."),
    ).toBeTruthy();
  });
});
