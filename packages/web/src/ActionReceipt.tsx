import type { ReactNode } from "react";

import { useI18n } from "./i18n";

export function ActionReceipt({
  children,
  className,
  onDismiss,
}: {
  children: ReactNode;
  className?: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className={["open-tab-action-receipt", className]
        .filter(Boolean)
        .join(" ")}
      role="status"
      tabIndex={-1}
    >
      {children}
      <button
        aria-label={t("Dismiss report")}
        className="action-receipt-dismiss"
        type="button"
        onClick={onDismiss}
      >
        {t("OK")}
      </button>
    </div>
  );
}
