/**
 * The splash mark. Inline SVG, no client JavaScript, no network request.
 *
 * This is the LCP element on the one screen that must not be in the way. A raster logo is a
 * second round trip on exactly the connection where a splash becomes visible at all, and a
 * font-based wordmark waits on the font. Geometry in the document beats both.
 *
 * The animation is CSS and reads the duration token, so `prefers-reduced-motion` — which
 * zeroes those tokens — stops it without this component knowing the preference exists. That
 * is the whole reason it is CSS: a requestAnimationFrame loop would need to ask, and this
 * one has nothing to ask with.
 */
export function SplashMark() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center"
      style={{ background: 'var(--surface-0)' }}
    >
      <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="Kiln">
        <title>Kiln</title>
        {/* Eleven marks for eleven pipeline stages, which is the only joke in the product. */}
        {Array.from({ length: 11 }, (_, i) => (
          <rect
            key={i}
            x={6 + i * 5.5}
            y={36 - (i % 3) * 6 - 6}
            width="3"
            height={12 + (i % 3) * 12}
            rx="1.5"
            // Not the accent: the mark is a brand element, not something you can act on,
            // and the rule that says so is right. --text-secondary reads as the wordmark it
            // effectively is.
            fill="var(--text-secondary)"
            opacity={0.25 + (i / 11) * 0.75}
          />
        ))}
      </svg>
    </div>
  );
}
