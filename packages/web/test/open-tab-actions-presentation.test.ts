import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenTabBulkToolbar } from "../src/OpenTabBulkToolbar";
import { SavedWorkspacesDrawer } from "../src/SavedWorkspacesDrawer";
import { TabOperationDialog } from "../src/TabOperationDialog";

describe("open-tab action presentation", () => {
  it("keeps every requested action in one compact selected-tabs toolbar", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        controlWindowId: 7,
        controllableCount: 12,
        destination: { kind: "app-window" },
        onClear: vi.fn(),
        onClose: vi.fn(),
        onCopy: vi.fn(),
        onDestinationChange: vi.fn(),
        onDiscard: vi.fn(),
        onMove: vi.fn(),
        onReload: vi.fn(),
        onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(),
        onSetMuted: vi.fn(),
        onSetPinned: vi.fn(),
        selectedCount: 17,
        windows: [{ focused: true, tabCount: 40, windowId: 7 }],
      }),
    );

    for (const label of ["Move", "Close 12", "Pin", "Unpin", "Mute", "Unmute", "Sleep", "Reload", "Save as workspace", "Save &amp; close", "Copy URLs", "Copy Markdown", "Copy JSON"]) {
      expect(markup).toContain(label);
    }
  });

  it("blocks browser actions instead of silently slicing selections over 500", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        controlWindowId: 7,
        controllableCount: 501,
        destination: { kind: "app-window" },
        onClear: vi.fn(), onClose: vi.fn(), onCopy: vi.fn(), onDestinationChange: vi.fn(),
        onDiscard: vi.fn(), onMove: vi.fn(), onReload: vi.fn(), onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(), onSetMuted: vi.fn(), onSetPinned: vi.fn(),
        selectedCount: 501,
        windows: [],
      }),
    );
    expect(markup).toContain("Select at most 500");
    expect(markup).toContain('disabled=""');
  });

  it("warns that reload can discard form state", () => {
    const markup = renderToStaticMarkup(
      createElement(TabOperationDialog, {
        busy: false,
        candidateCount: 3,
        kind: "reload",
        protectedCount: 0,
        onConfirm: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(markup).toContain("unsaved form edits");
  });

  it("exposes the workspace overlay as a modal dialog", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SavedWorkspacesDrawer, {
          busy: false,
          onClose: vi.fn(),
          onCommand: vi.fn(),
        }),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="saved-workspaces-title"');
  });
});
