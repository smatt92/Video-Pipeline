/**
 * The brand v2 mark and lockup (canvas: BrandLogo).
 *
 * Solid arch on a 32 grid — radius 11 on centre 16,15 — with a door a third of its width
 * sitting on the baseline. Below 20px the 16-grid redraw is used instead of a scaled copy:
 * a wider door, arch radius 6, which is what keeps the door visible in a browser tab.
 *
 * Colours come from `.kmark` / `.wm` in kiln.css, so the component carries no colour of its
 * own: `dark` is chalk + teal (default), `light` is ink + the paper teal, `mono` follows
 * `currentColor` with the door cut out. Don't recolour the door — cast colours belong to cast.
 */

export type MarkTone = 'dark' | 'light' | 'mono';

export function KilnMark({ size = 22, tone = 'dark', className = '' }: { size?: number; tone?: MarkTone; className?: string }) {
  const cls = `kmark${tone === 'dark' ? '' : ` ${tone}`} ${className}`.trim();
  if (tone === 'mono') {
    return (
      <svg className={cls} viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <path className="arch" fillRule="evenodd" d="M5 29V15a11 11 0 0 1 22 0v14zM12.5 29v-6.5a3.5 3.5 0 0 1 7 0V29z" />
      </svg>
    );
  }
  if (size < 20) {
    return (
      <svg className={cls} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
        <path className="arch" d="M2 15V8a6 6 0 0 1 12 0v7z" />
        <path className="door" d="M6.2 15v-2.8a1.8 1.8 0 0 1 3.6 0V15z" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path className="arch" d="M5 29V15a11 11 0 0 1 22 0v14z" />
      <path className="door" d="M12.5 29v-6.5a3.5 3.5 0 0 1 7 0V29z" />
    </svg>
  );
}

/** Lowercase "kıln" — dotless i with the teal square tittle, which is the channel square. */
export function Wordmark({ tone = 'dark' }: { tone?: MarkTone }) {
  return (
    <span className={`wm${tone === 'dark' ? '' : ` ${tone}`}`}>
      k<span className="i">ı</span>ln
    </span>
  );
}

/**
 * Mark + wordmark. `fontSize` sets the wordmark; the mark is drawn ~1.15× it, as on the canvas
 * (19px wordmark → 22px mark in the rail).
 */
export function Lockup({ fontSize = 19, tone = 'dark' }: { fontSize?: number; tone?: MarkTone }) {
  return (
    <span className="lockup" style={{ fontSize }}>
      <KilnMark size={Math.round(fontSize * 1.16)} tone={tone} />
      <Wordmark tone={tone} />
    </span>
  );
}
