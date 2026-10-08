/**
 * The glass gauge: a share of a cap. `share` null = no cap or no figure → the track renders
 * empty and the caller's text says why (never a bar that implies 0%). `warn` from 90% up.
 */
export function Gauge({ share, label }: { share: number | null; label: string }) {
  const pct = share === null ? 0 : Math.max(0, Math.min(1, share));
  return (
    <div
      className={`gauge${share !== null && share >= 0.9 ? ' warn' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={share === null ? undefined : Math.round(pct * 100)}
    >
      <i style={{ width: `${pct * 100}%` }} />
    </div>
  );
}
