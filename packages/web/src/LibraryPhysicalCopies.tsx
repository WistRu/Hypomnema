import type { TabInstance, TabListItem } from "@tabhub/shared";
import { useId, useState } from "react";

import { useI18n } from "./i18n";

export interface LibraryPhysicalCopiesProps {
  expanded?: boolean;
  instances: readonly TabInstance[];
  selection: ReadonlyMap<number, TabInstance>;
  selectionEnabled: boolean;
  tab: TabListItem;
  activationErrorFor?: (instanceId: number) => string | undefined;
  closeErrorFor?: (instanceId: number) => string | undefined;
  isActivating?: (instanceId: number) => boolean;
  isClosing?: (instanceId: number) => boolean;
  onActivate: (instance: TabInstance) => void;
  onClose: (instance: TabInstance) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onSelectedChange: (instance: TabInstance, selected: boolean) => void;
}

type PhysicalCopyProps = Omit<
  LibraryPhysicalCopiesProps,
  "expanded" | "instances" | "onExpandedChange"
> & {
  activationControl?: boolean;
  instance: TabInstance;
};

function copyLabel(instance: TabInstance, tab: TabListItem): string {
  return instance.title?.trim() || tab.title?.trim() || instance.url;
}

function compactScopeId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function browserLabel(browser: string, t: (key: string) => string): string {
  const key = browser.toLowerCase();
  if (key === "chrome") return t("Chrome");
  if (key === "edge") return t("Edge");
  if (key === "yandex") return t("Yandex");
  if (key === "other") return t("Other");
  return browser;
}

export function physicalTabAccessibleLabel(
  instance: TabInstance,
  fallbackLabel: string,
  t: (key: string, params?: Record<string, number | string>) => string,
  formatNumber: (value: number) => string,
): string {
  const location = t("Window {windowId} | position {position} | {tab}", {
    position: formatNumber(instance.index + 1),
    tab:
      instance.browserTabId === null
        ? t("unknown tab")
        : t("tab {tabId}", { tabId: formatNumber(instance.browserTabId) }),
    windowId: formatNumber(instance.windowId),
  });
  return [
    fallbackLabel,
    browserLabel(instance.browser, t),
    t("Installation {id}", { id: instance.installationId }),
    instance.browserSessionId
      ? t("Session {id}", { id: instance.browserSessionId })
      : null,
    location,
    instance.url,
  ].filter((value): value is string => value !== null).join(" | ");
}

function PhysicalCopy({
  activationControl = true,
  instance,
  selection,
  selectionEnabled,
  tab,
  activationErrorFor = () => undefined,
  closeErrorFor = () => undefined,
  isActivating = () => false,
  isClosing = () => false,
  onActivate,
  onClose,
  onSelectedChange,
}: PhysicalCopyProps) {
  const { formatNumber, t } = useI18n();
  const label = copyLabel(instance, tab);
  const accessibleLabel = physicalTabAccessibleLabel(
    instance,
    label,
    t,
    formatNumber,
  );
  const activating = isActivating(instance.instanceId);
  const closing = isClosing(instance.instanceId);
  const error =
    closeErrorFor(instance.instanceId) ??
    activationErrorFor(instance.instanceId);

  return (
    <div className="library-physical-copy">
      {selectionEnabled ? (
        <input
          aria-label={t("Select {tab}", { tab: accessibleLabel })}
          checked={selection.has(instance.instanceId)}
          type="checkbox"
          onChange={(event) => onSelectedChange(instance, event.target.checked)}
        />
      ) : null}
      <div className="library-physical-copy-identity">
        {activationControl ? (
          <button
            aria-label={t("Switch to existing tab: {label}", {
              label: accessibleLabel,
            })}
            className="physical-tab-switch"
            disabled={activating || closing}
            type="button"
            onClick={() => onActivate(instance)}
          >
            {label}
          </button>
        ) : (
          <span className="physical-tab-label">{label}</span>
        )}
        <span
          className="physical-owner"
          title={[
            instance.browser,
            instance.installationId,
            instance.browserSessionId ?? "",
          ].filter(Boolean).join(" | ")}
        >
          <span>{browserLabel(instance.browser, t)}</span>
          <span>
            {t("Installation {id}", {
              id: compactScopeId(instance.installationId),
            })}
          </span>
          {instance.browserSessionId ? (
            <span>
              {t("Session {id}", {
                id: compactScopeId(instance.browserSessionId),
              })}
            </span>
          ) : null}
        </span>
        <span className="physical-tab-url" title={instance.url}>
          {instance.url}
        </span>
        <span className="physical-location">
          {t("Window {windowId} | position {position} | {tab}", {
            position: formatNumber(instance.index + 1),
            tab:
              instance.browserTabId === null
                ? t("unknown tab")
                : t("tab {tabId}", {
                    tabId: formatNumber(instance.browserTabId),
                  }),
            windowId: formatNumber(instance.windowId),
          })}
        </span>
        <div className="physical-flags">
          {instance.active ? (
            <span className="physical-flag is-active">{t("Active")}</span>
          ) : null}
          {instance.pinned ? (
            <span className="physical-flag is-protected">{t("Pinned")}</span>
          ) : null}
          {instance.audible ? (
            <span className="physical-flag is-audible">{t("Playing")}</span>
          ) : null}
          {instance.muted ? (
            <span className="physical-flag is-muted">{t("Muted")}</span>
          ) : null}
          {instance.discarded ? (
            <span className="physical-flag is-sleeping">{t("Sleeping")}</span>
          ) : null}
          {!instance.active &&
          !instance.pinned &&
          !instance.audible &&
          !instance.muted &&
          !instance.discarded ? (
            <span className="physical-flag">{t("Standard")}</span>
          ) : null}
        </div>
        {activating || closing ? (
          <span className="physical-tab-action-state" role="status">
            {activating ? t("Switching...") : t("Closing...")}
          </span>
        ) : error ? (
          <span className="physical-tab-action-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <button
        aria-label={t("{action} for {tab}", {
          action: t("Close"),
          tab: accessibleLabel,
        })}
        className="library-physical-copy-close"
        disabled={activating || closing}
        type="button"
        onClick={() => onClose(instance)}
      >
        {t("Close")}
      </button>
    </div>
  );
}

export function LibraryPhysicalCopies({
  expanded: controlledExpanded,
  instances,
  onExpandedChange,
  ...props
}: LibraryPhysicalCopiesProps) {
  const { formatNumber, t } = useI18n();
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const setExpanded = (next: boolean) => {
    if (controlledExpanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  const copiesId = useId();

  if (instances.length === 0) {
    return <span className="no-library-activity">{t("No open copies")}</span>;
  }

  if (instances.length === 1) {
    return (
      <div className="library-physical-copies is-single">
        <PhysicalCopy
          activationControl={false}
          instance={instances[0]!}
          {...props}
        />
      </div>
    );
  }

  const countLabel = t("{count} open copies", {
    count: formatNumber(instances.length),
    rawCount: instances.length,
  });

  return (
    <div className="library-physical-copies is-repeated">
      <button
        aria-controls={copiesId}
        aria-expanded={expanded}
        aria-label={countLabel}
        className="library-physical-copies-toggle"
        type="button"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{countLabel}</span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded ? (
        <ul className="library-physical-copy-list" id={copiesId}>
          {instances.map((instance) => (
            <li key={instance.instanceId}>
              <PhysicalCopy instance={instance} {...props} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
