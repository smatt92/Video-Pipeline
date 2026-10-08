/**
 * The dot-matrix sparkline (Kiln Glass): one column per bucket, five dots tall, lit from the
 * bottom. `values` are the real figures; the component scales them to 0–5 dots against the
 * largest (or against `max` when the series has a ceiling, such as a cap).
 *
 * Absent is not zero: a `null` bucket draws no column at all — not an empty one — and a series
 * with no readable value renders nothing, so a sparkline of nothing never reads as a flat line
 * of "spent ₹0 every day". The accessible name says what the dots say, in words.
 */
export function DotMatrix({
  values,
  max,
  peak = 'max',
  label,
}: {
  values: readonly (number | null)[];
  /** Scale ceiling. Default: the largest value in the series. */
  max?: number | null;
  /** Which column glows: the largest ('max'), a given index, or none. */
  peak?: 'max' | number | null;
  label: string;
}) {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return null;
  const top = max && max > 0 ? max : Math.max(...known);
  const peakIdx = peak === 'max' ? (top > 0 ? values.indexOf(Math.max(...known)) : -1) : peak;
  const level = (v: number) => (top <= 0 ? 0 : v <= 0 ? 0 : Math.max(1, Math.min(5, Math.round((v / top) * 5))));
  return (
    <div className="dmx" role="img" aria-label={label}>
      {values.map((v, i) =>
        v === null ? null : (
          [0, 1, 2, 3, 4].map((r) => {
            const on = r >= 5 - level(v);
            return <span key={`${i}-${r}`} className={on ? (i === peakIdx ? 'pk' : 'on') : undefined} />;
          })
        ),
      )}
    </div>
  );
}
