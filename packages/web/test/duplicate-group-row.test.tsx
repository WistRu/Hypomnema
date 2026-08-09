import type { TabInstance } from "@tabhub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "../src/i18n";
import { OpenTabRow } from "../src/OpenTabsView";

function tab(instanceId: number, windowId: number): TabInstance {
  return {
    instanceId,
    canonicalTabId: 1,
    installationId: "chrome-main",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    browserTabId: instanceId + 100,
    url: "https://example.com/exact",
    urlNormalized: "https://example.com/exact",
    title: `Copy ${instanceId}`,
    browser: "chrome",
    windowId,
    index: 0,
    faviconUrl: null,
    active: false,
    audible: false,
    muted: false,
    discarded: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: "2026-08-09T10:00:00.000Z",
    lastSeenAt: "2026-08-09T10:00:00.000Z",
    status: "inbox",
    importance: "medium",
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 2,
  };
}

describe("duplicate group row", () => {
  it("names the kept physical tab and keeps activation on the existing tab", () => {
    const keeper = tab(11, 7);
    const duplicate = tab(12, 9);
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="ru">
        <table>
          <tbody>
            <OpenTabRow
              activation={{
                kind: "ready",
                target: {
                  browser: "chrome",
                  browserSessionId: duplicate.browserSessionId!,
                  installationId: duplicate.installationId,
                  tabId: duplicate.browserTabId!,
                },
              }}
              duplicateRelationship={{ keeper, role: "duplicate" }}
              tab={duplicate}
              onActivateTab={() => undefined}
              onSelectCanonicalTab={() => undefined}
            />
          </tbody>
        </table>
      </I18nProvider>,
    );

    expect(markup).toContain("Дубликат сохраняемой копии");
    expect(markup).toContain("Сохраняемая копия: Окно 7");
    expect(markup).toContain("Перейти к существующей вкладке: Copy 12");
    expect(markup).not.toContain('target="_blank"');
  });

  it("can lock the keeper checkbox while leaving a close candidate selectable", () => {
    const keeper = tab(11, 7);
    const duplicate = tab(12, 9);
    const renderRow = (role: "keeper" | "duplicate", selectionDisabled: boolean) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="en">
          <table>
            <tbody>
              <OpenTabRow
                activation={{ kind: "bridge-unavailable", message: "offline" }}
                duplicateRelationship={{ keeper, role }}
                selectionDisabled={selectionDisabled}
                tab={role === "keeper" ? keeper : duplicate}
                onActivateTab={() => undefined}
                onSelectedChange={() => undefined}
                onSelectCanonicalTab={() => undefined}
              />
            </tbody>
          </table>
        </I18nProvider>,
      );

    expect(renderRow("keeper", true)).toContain('disabled=""');
    expect(renderRow("duplicate", false)).not.toContain('disabled=""');
  });

  it("offers an explicit keeper switch only on a closable duplicate", () => {
    const keeper = { ...tab(11, 7), active: true };
    const duplicate = tab(12, 9);
    const renderRow = (
      role: "keeper" | "duplicate",
      onKeepThisCopy?: () => void,
    ) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="en">
          <table>
            <tbody>
              <OpenTabRow
                activation={{ kind: "bridge-unavailable", message: "offline" }}
                duplicateRelationship={{
                  keeper,
                  onKeepThisCopy,
                  role,
                }}
                tab={role === "keeper" ? keeper : duplicate}
                onActivateTab={() => undefined}
                onSelectCanonicalTab={() => undefined}
              />
            </tbody>
          </table>
        </I18nProvider>,
      );

    expect(renderRow("duplicate", () => undefined)).toContain(
      "Keep this copy instead",
    );
    expect(renderRow("keeper")).not.toContain("Keep this copy instead");
  });
});
