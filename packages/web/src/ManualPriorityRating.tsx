export function ManualPriorityRating({
  busy = false,
  labels,
  value,
  onChange,
}: {
  readonly busy?: boolean;
  readonly labels: {
    readonly group: string;
    readonly clear: string;
    readonly level: (value: 1 | 2 | 3) => string;
  };
  readonly value: 1 | 2 | 3 | null;
  readonly onChange: (value: 1 | 2 | 3 | null) => void;
}) {
  return (
    <fieldset className="manual-priority-rating">
      <legend>{labels.group}</legend>
      <button
        aria-pressed={value === null}
        disabled={busy}
        type="button"
        onClick={() => onChange(null)}
      >
        {labels.clear}
      </button>
      {([1, 2, 3] as const).map((level) => (
        <button
          aria-pressed={value === level}
          disabled={busy}
          key={level}
          type="button"
          onClick={() => onChange(level)}
        >
          {labels.level(level)}
        </button>
      ))}
    </fieldset>
  );
}
