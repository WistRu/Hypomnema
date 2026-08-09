import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenTabBulkToolbar } from "../src/OpenTabBulkToolbar";
import { SavedWorkspacesDrawer } from "../src/SavedWorkspacesDrawer";
import { TabOperationDialog } from "../src/TabOperationDialog";

function buttonOpeningTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(`>${label}</button>`);
  if (labelIndex < 0) throw new Error(`Button not found: ${label}`);
  const buttonIndex = markup.lastIndexOf("<button", labelIndex);
  if (buttonIndex < 0) throw new Error(`Button opening tag not found: ${label}`);
  return markup.slice(buttonIndex, labelIndex + 1);
}

describe("open-tab action presentation", () => {
  it("explains why a mixed-browser selection cannot be changed partially", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 0,
        controlStatus: "Selection spans multiple browser profiles. Select one profile for browser actions.",
        controlWindowId: null,
        controllableCount: 0,
        destination: { kind: "new-window" },
        onClear: vi.fn(), onClose: vi.fn(), onCopy: vi.fn(), onDestinationChange: vi.fn(),
        onDiscard: vi.fn(), onMove: vi.fn(), onReload: vi.fn(), onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(), onSetMuted: vi.fn(), onSetPinned: vi.fn(),
        selectedCount: 2,
        showAppWindowDestination: false,
        windows: [],
      }),
    );

    expect(markup).toContain("Selection spans multiple browser profiles");
    expect(buttonOpeningTag(markup, "Move")).toContain('disabled=""');
  });

  it("shows only the owning browser's destinations for a relayed selection", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 2,
        controlStatus: "2 selected in Yandex · installation 323e4567…",
        controlWindowId: null,
        controllableCount: 2,
        destination: { kind: "window", windowId: 19 },
        onClear: vi.fn(), onClose: vi.fn(), onCopy: vi.fn(), onDestinationChange: vi.fn(),
        onDiscard: vi.fn(), onMove: vi.fn(), onReload: vi.fn(), onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(), onSetMuted: vi.fn(), onSetPinned: vi.fn(),
        selectedCount: 2,
        showAppWindowDestination: false,
        windows: [{ focused: true, tabCount: 33, windowId: 19 }],
      }),
    );

    expect(markup).toContain("Window 19");
    expect(markup).not.toContain("This TabHub window");
    expect(buttonOpeningTag(markup, "Move")).not.toContain('disabled=""');
  });

  it("keeps every requested action in one compact selected-tabs toolbar", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 12,
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

  it("keeps every browser action enabled for selections over 500", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 501,
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
    expect(markup).not.toContain("Select at most 500");
    expect(markup).not.toContain('disabled=""');
  });

  it("keeps addressed close available when other live actions are unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 2,
        controlWindowId: null,
        controllableCount: 0,
        destination: { kind: "app-window" },
        onClear: vi.fn(), onClose: vi.fn(), onCopy: vi.fn(), onDestinationChange: vi.fn(),
        onDiscard: vi.fn(), onMove: vi.fn(), onReload: vi.fn(), onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(), onSetMuted: vi.fn(), onSetPinned: vi.fn(),
        selectedCount: 2,
        windows: [],
      }),
    );

    expect(buttonOpeningTag(markup, "Close 2…")).not.toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Save &amp; close…")).not.toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Move")).toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Pin")).toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Reload…")).toContain('disabled=""');
  });

  it("disables addressed close without disabling other controllable actions", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabBulkToolbar, {
        busy: false,
        closeableCount: 0,
        controlWindowId: 7,
        controllableCount: 3,
        destination: { kind: "app-window" },
        onClear: vi.fn(), onClose: vi.fn(), onCopy: vi.fn(), onDestinationChange: vi.fn(),
        onDiscard: vi.fn(), onMove: vi.fn(), onReload: vi.fn(), onSaveWorkspace: vi.fn(),
        onSaveWorkspaceAndClose: vi.fn(), onSetMuted: vi.fn(), onSetPinned: vi.fn(),
        selectedCount: 3,
        windows: [],
      }),
    );

    expect(buttonOpeningTag(markup, "Close 0…")).toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Save &amp; close…")).toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Move")).not.toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Pin")).not.toContain('disabled=""');
    expect(buttonOpeningTag(markup, "Reload…")).not.toContain('disabled=""');
  });

  it("keeps restore controls enabled for workspaces over 500 tabs", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspaces"], {
      items: [
        {
          createdAt: "2026-08-09T00:00:00.000Z",
          id: 1,
          itemCount: 501,
          name: "All tabs",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SavedWorkspacesDrawer, {
          busy: false,
          onClose: vi.fn(),
          onCommand: vi.fn(),
          targets: [
            {
              direct: true,
              label: "Chrome · local",
              scope: {
                browser: "chrome",
                browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
                installationId: "123e4567-e89b-42d3-a456-426614174000",
              },
            },
          ],
        }),
      ),
    );

    expect(markup).toContain("501 tabs");
    expect(markup).not.toContain("Restore limit");
    expect(markup).not.toContain('disabled=""');
  });

  it("restores a workspace into a connected remote profile only in a new window", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspaces"], {
      items: [
        {
          createdAt: "2026-08-09T00:00:00.000Z",
          id: 1,
          itemCount: 3,
          name: "Remote session",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SavedWorkspacesDrawer, {
          busy: false,
          onClose: vi.fn(),
          onCommand: vi.fn(),
          targets: [
            {
              direct: false,
              label: "Yandex · 323e4567…",
              scope: {
                browser: "yandex",
                browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
                installationId: "323e4567-e89b-42d3-a456-426614174000",
              },
            },
          ],
        }),
      ),
    );

    expect(markup).toContain("Browser profile");
    expect(markup).toContain("Yandex");
    expect(markup).toContain("New window");
    expect(markup).not.toContain("Open here");
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

  it("blocks confirmation when a strict duplicate-group preview became partial", () => {
    const markup = renderToStaticMarkup(
      createElement(TabOperationDialog, {
        blockingMessage:
          "The duplicate group changed. Refresh the list and try again; no tabs will be closed.",
        busy: false,
        candidateCount: 1,
        confirmationBlocked: true,
        kind: "close",
        protectedCount: 1,
        onConfirm: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(markup).toContain("The duplicate group changed");
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/class="danger-action" disabled=""/);
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
          targets: [],
        }),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="saved-workspaces-title"');
  });
});
