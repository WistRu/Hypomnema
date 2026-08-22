import { useId } from "react";

import type { PriorityListSelection } from "./priority-personalization-model";

interface Labels {
  readonly mode: string;
  readonly review: string;
  readonly default: string;
  readonly my: string;
  readonly ai: string;
  readonly recommended: string;
  readonly all: string;
  readonly needsReview: string;
  readonly doesNotNeedReview: string;
}

export function LibraryPriorityControls({
  disabled = false,
  labels,
  selection,
  onChange,
}: {
  readonly disabled?: boolean;
  readonly labels: Labels;
  readonly selection: PriorityListSelection;
  readonly onChange: (selection: PriorityListSelection) => void;
}) {
  const modeName = useId();
  const reviewName = useId();
  return (
    <div className="library-priority-controls">
      <fieldset>
        <legend>{labels.mode}</legend>
        {([
          ["default", labels.default],
          ["my", labels.my],
          ["ai", labels.ai],
          ["recommended", labels.recommended],
        ] as const).map(([mode, label]) => (
          <label key={mode}>
            <input
              checked={selection.mode === mode}
              disabled={disabled}
              name={modeName}
              type="radio"
              onChange={() => onChange({ ...selection, mode })}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{labels.review}</legend>
        {([
          ["all", labels.all],
          ["needs_review", labels.needsReview],
          ["does_not_need_review", labels.doesNotNeedReview],
        ] as const).map(([review, label]) => (
          <label key={review}>
            <input
              checked={selection.review === review}
              disabled={disabled}
              name={reviewName}
              type="radio"
              onChange={() => onChange({ ...selection, review })}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
