// @vitest-environment jsdom

import type { TabInstance, TabListItem } from "@tabhub/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { LibraryPhysicalCopies } from "../src/LibraryPhysicalCopies";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

function canonicalTab(openInstanceCount: number): TabListItem {
  return {
    browser: "chrome",
    closedAt: openInstanceCount === 0 ? "2026-08-11T00:02:00.000Z" : null,
    faviconUrl: null,
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    id: 7,
    importance: 0,
    index: openInstanceCount === 0 ? null : 0,
    isOpen: openInstanceCount > 0,
    lastSeenAt: "2026-08-11T00:01:00.000Z",
    openEngagedTimeMs: 0,
    openForegroundTimeMs: 0,
    openInstanceCount,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Canonical page",
    url: "https://example.com/page",
    urlNormalized: "https://example.com/page",
    windowId: openInstanceCount === 0 ? null : 1,
  };
}

function physicalTab(instanceId: number, windowId: number): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    browserTabId: 100 + instanceId,
    canonicalTabId: 7,
    discarded: false,
    duplicateGroupSize: 1,
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
    url: "https://example.com/page",
    urlNormalized: "https://example.com/page",
    windowId,
  };
}

function renderCopies(instances: TabInstance[], selectionEnabled = true) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onSelectedChange = vi.fn();
  render(
    <I18nProvider initialLocale="en">
      <LibraryPhysicalCopies
        instances={instances}
        selection={new Map()}
        selectionEnabled={selectionEnabled}
        tab={canonicalTab(instances.length)}
        onActivate={onActivate}
        onClose={onClose}
        onSelectedChange={onSelectedChange}
      />
    </I18nProvider>,
  );
  return { onActivate, onClose, onSelectedChange };
}

afterEach(() => {
  cleanup();
});

describe("Library physical copies", () => {
  it("renders a closed canonical page without a physical-tab picker", () => {
    renderCopies([]);

    expect(screen.getByText("No open copies")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renders the sole physical copy as compact metadata without repeating the page", () => {
    const onlyCopy = physicalTab(1, 4);
    const { onActivate, onClose, onSelectedChange } = renderCopies([onlyCopy]);

    expect(
      screen.queryByRole("button", { name: "1 open copy" }),
    ).toBeNull();

    expect(
      screen.queryByRole("button", {
        name: /^Switch to existing tab: Physical copy 1 \|/,
      }),
    ).toBeNull();
    expect(screen.queryByText("Physical copy 1")).toBeNull();
    expect(screen.queryByText("https://example.com/page")).toBeNull();
    expect(screen.getByText("Chrome")).toBeTruthy();
    expect(screen.getByText("Window 4 | position 1 | tab 101")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /^Close for Physical copy 1 \|/ }),
    );

    expect(onActivate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(onlyCopy);
    expect(onSelectedChange).not.toHaveBeenCalled();
  });

  it("expands repeated copies and addresses the chosen physical instance", () => {
    const firstCopy = physicalTab(1, 4);
    const secondCopy = {
      ...physicalTab(2, 9),
      audible: true,
      browser: "edge",
      browserSessionId: "session-beta-123456789",
      installationId: "profile-beta-123456789",
      pinned: true,
    };
    const { onActivate, onClose, onSelectedChange } = renderCopies([
      firstCopy,
      secondCopy,
    ]);
    const expander = screen.getByRole("button", { name: "2 open copies" });

    expect(expander.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", {
        name: /^Switch to existing tab: Physical copy 2 \|/,
      }),
    ).toBeNull();

    fireEvent.click(expander);

    expect(expander.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Chrome")).toBeTruthy();
    expect(screen.getByText("Installation 123e4567…")).toBeTruthy();
    expect(screen.getByText("Session 223e4567…")).toBeTruthy();
    expect(screen.getByText("Edge")).toBeTruthy();
    expect(screen.getByText("Installation profile-…")).toBeTruthy();
    expect(screen.getByText("Session session-…")).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("Playing")).toBeTruthy();
    expect(screen.getAllByText("https://example.com/page")).toHaveLength(2);
    expect(screen.getByText("Window 4 | position 1 | tab 101")).toBeTruthy();
    expect(screen.getByText("Window 9 | position 2 | tab 102")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Switch to existing tab: Physical copy 2 \|/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Close for Physical copy 2 \|/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /^Select Physical copy 2 \|/ }),
    );

    expect(onActivate).toHaveBeenCalledWith(secondCopy);
    expect(onClose).toHaveBeenCalledWith(secondCopy);
    expect(onSelectedChange).toHaveBeenCalledWith(secondCopy, true);
  });

  it("keeps exact copy actions without mixing physical selection into page mode", () => {
    const onlyCopy = physicalTab(1, 4);
    const { onActivate, onClose } = renderCopies([onlyCopy], false);

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Close for Physical copy 1 \|/,
      }),
    );
    expect(onActivate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(onlyCopy);
  });

  it("keeps duplicate-copy controls from opening the canonical row", () => {
    const firstCopy = physicalTab(1, 4);
    const secondCopy = physicalTab(2, 9);
    const onParentClick = vi.fn();
    const onClose = vi.fn();

    render(
      <I18nProvider initialLocale="en">
        <div onClick={onParentClick}>
          <LibraryPhysicalCopies
            expanded
            instances={[firstCopy, secondCopy]}
            selection={new Map()}
            selectionEnabled
            tab={canonicalTab(2)}
            onActivate={vi.fn()}
            onClose={onClose}
            onSelectedChange={vi.fn()}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^Close for Physical copy 2 \|/ }),
    );

    expect(onClose).toHaveBeenCalledWith(secondCopy);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("shows exact-instance failures next to the affected copy", () => {
    const onlyCopy = physicalTab(1, 4);
    render(
      <I18nProvider initialLocale="en">
        <LibraryPhysicalCopies
          activationErrorFor={() => "Owning browser is offline"}
          instances={[onlyCopy]}
          selection={new Map()}
          selectionEnabled={false}
          tab={canonicalTab(1)}
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onSelectedChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "Owning browser is offline",
    );
  });
});
