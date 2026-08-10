import type { TabListItem } from "@tabhub/shared";

import { useI18n } from "./i18n";
import {
  handleMiddleClickClose,
  preventMiddleClickAutoscroll,
} from "./middle-click-close";
import type { CanonicalTabBrowserActionRequest } from "./open-tab-activation";

type BrowserActionTab = Pick<
  TabListItem,
  "id" | "isOpen" | "title" | "url"
>;

function displayTitle(tab: BrowserActionTab): string {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url;
  }
}

export function TabBrowserAction({
  activationError,
  activationInProgress = false,
  className,
  closeInProgress = false,
  isActivating = false,
  stopPropagation = false,
  tab,
  onBrowserAction,
  onMiddleClose,
}: {
  activationError?: string | undefined;
  activationInProgress?: boolean | undefined;
  className?: string | undefined;
  closeInProgress?: boolean | undefined;
  isActivating?: boolean | undefined;
  stopPropagation?: boolean | undefined;
  tab: BrowserActionTab;
  onBrowserAction: (request: CanonicalTabBrowserActionRequest) => void;
  onMiddleClose?: ((canonicalTabId: number) => void) | undefined;
}) {
  const { t } = useI18n();
  const label = displayTitle(tab);

  return (
    <>
      <button
        aria-label={
          tab.isOpen
            ? t("Switch to open tab: {tab}", { tab: label })
            : t("Open {tab} in browser", { tab: label })
        }
        className={className}
        disabled={activationInProgress || isActivating || closeInProgress}
        title={
          tab.isOpen
            ? t("Switch to this existing browser tab. Middle-click to close it.")
            : tab.url
        }
        type="button"
        onAuxClick={(event) => {
          if (!tab.isOpen || onMiddleClose === undefined) return;
          handleMiddleClickClose(event, () => onMiddleClose(tab.id));
        }}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          onBrowserAction({
            canonicalTabId: tab.id,
            newTabUrlIfConfirmedClosed: tab.isOpen ? undefined : tab.url,
          });
        }}
        onMouseDown={preventMiddleClickAutoscroll}
      >
        {closeInProgress
          ? t("Closing...")
          : isActivating
            ? t("Switching...")
            : tab.isOpen
              ? t("Switch to open tab")
              : t("Open in browser")}
      </button>
      {activationError ? (
        <span className="tab-browser-action-error" role="alert">
          {activationError}
        </span>
      ) : null}
    </>
  );
}
