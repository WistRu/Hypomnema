import type { TabInstance } from "@tabhub/shared";

export type TabExportFormat = "json" | "markdown" | "urls";

function label(tab: TabInstance): string {
  return tab.title?.trim() || tab.url;
}

function markdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function markdownUrl(value: string): string {
  return value.replace(/>/g, "%3E");
}

export function serializeTabs(
  tabs: readonly TabInstance[],
  format: TabExportFormat,
): string {
  if (format === "urls") return tabs.map(({ url }) => url).join("\n");
  if (format === "markdown") {
    return tabs
      .map((tab) => `- [${markdownLabel(label(tab))}](<${markdownUrl(tab.url)}>)`)
      .join("\n");
  }
  return JSON.stringify(
    tabs.map((tab) => ({
      browser: tab.browser,
      index: tab.index,
      pinned: tab.pinned,
      title: tab.title,
      url: tab.url,
      windowId: tab.windowId,
    })),
    null,
    2,
  );
}
