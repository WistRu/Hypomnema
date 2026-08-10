import { useI18n } from "./i18n";

export function OpenCopyCount({ count }: { count: number }) {
  const { formatNumber, t } = useI18n();

  return (
    <>
      {t(count === 1 ? "{count} open copy" : "{count} open copies", {
        count: formatNumber(count),
        rawCount: count,
      })}
    </>
  );
}

export function ActivityMetrics({
  engagedTimeMs,
  foregroundTimeMs,
}: {
  engagedTimeMs: number;
  foregroundTimeMs: number;
}) {
  const { formatDuration, t } = useI18n();
  const foregroundDescription = t(
    "Selected while its browser window was in the foreground and the computer was active.",
  );
  const engagedDescription = t(
    "On-screen time within 60 seconds of recent mouse, keyboard, scroll, or touch input.",
  );

  return (
    <div className="activity-metrics-block">
      <dl className="activity-metrics">
        <div className="activity-metric" title={foregroundDescription}>
          <dt>{t("On screen")}</dt>
          <dd>{formatDuration(foregroundTimeMs)}</dd>
        </div>
        <div className="activity-metric" title={engagedDescription}>
          <dt>{t("Active use")}</dt>
          <dd>{formatDuration(engagedTimeMs)}</dd>
        </div>
      </dl>
      <details
        className="activity-metrics-help"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <summary title={t("How activity is measured")}>
          <span aria-hidden="true">?</span>
          <span className="sr-only">{t("How activity is measured")}</span>
        </summary>
        <div className="activity-metrics-help-copy">
          <p>
            <strong>{t("On screen")}:</strong> {foregroundDescription}
          </p>
          <p>
            <strong>{t("Active use")}:</strong> {engagedDescription}
          </p>
        </div>
      </details>
    </div>
  );
}
