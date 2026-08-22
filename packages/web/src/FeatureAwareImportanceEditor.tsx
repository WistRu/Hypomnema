import { type TabImportance } from "@tabhub/shared";
import { useQuery } from "@tanstack/react-query";

import { fetchFeatureFlags } from "./api";
import { useI18n } from "./i18n";
import { LegacyImportanceReview } from "./LegacyImportanceReview";

interface FeatureAwareImportanceEditorProps {
  headingId: string;
  legacyBusy: boolean;
  legacyImportance: TabImportance;
  tabId: number;
  onCanonicalChanged: (importance: TabImportance) => void;
  onLegacySelect: (importance: TabImportance) => void;
}

function LegacyImportanceEditor({
  busy,
  importance,
  onSelect,
}: {
  busy: boolean;
  importance: TabImportance;
  onSelect: (importance: TabImportance) => void;
}) {
  const { t } = useI18n();

  return (
    <fieldset className="importance-editor">
      <legend>{t("Importance")}</legend>
      <div className="importance-choices">
        {([0, 1, 2, 3] as TabImportance[]).map((level) => (
          <button
            aria-pressed={importance === level}
            disabled={busy}
            key={level}
            type="button"
            onClick={() => onSelect(level)}
          >
            {level}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function FeatureAwareImportanceEditor({
  headingId,
  legacyBusy,
  legacyImportance,
  tabId,
  onCanonicalChanged,
  onLegacySelect,
}: FeatureAwareImportanceEditorProps) {
  const { errorMessage, t } = useI18n();
  const featuresQuery = useQuery({
    queryKey: ["features"],
    queryFn: ({ signal }) => fetchFeatureFlags(signal),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (featuresQuery.data?.logicalImportance === false) {
    return (
      <LegacyImportanceEditor
        busy={legacyBusy}
        importance={legacyImportance}
        onSelect={onLegacySelect}
      />
    );
  }

  if (featuresQuery.data?.logicalImportance === true) {
    return (
      <LegacyImportanceReview
        headingId={headingId}
        tabId={tabId}
        onChanged={onCanonicalChanged}
      />
    );
  }

  return (
    <fieldset
      aria-busy={featuresQuery.isFetching}
      className="importance-editor feature-importance-state"
    >
      <legend>{t("Importance")}</legend>
      {featuresQuery.isError ? (
        <>
          <span className="drawer-error" role="alert">
            {errorMessage(featuresQuery.error)}
          </span>
          <button
            disabled={featuresQuery.isFetching}
            type="button"
            onClick={() => void featuresQuery.refetch()}
          >
            {t("Try again")}
          </button>
        </>
      ) : (
        <span className="importance-feature-loading" role="status">
          {t("Checking importance mode")}
        </span>
      )}
    </fieldset>
  );
}
