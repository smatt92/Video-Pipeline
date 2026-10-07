/**
 * The kiln object (canvas: BrandObject, BrandApplied sign-in splash). App level only — the
 * studio's object, never on the same screen as a channel's Bureau building. It floats under
 * `prefers-reduced-motion: no-preference` and sits still otherwise (the token block zeroes it).
 */
export function KilnObject({ width = 320, label = 'The Kiln object' }: { width?: number; label?: string }) {
  return (
    <svg className="kobj" viewBox="40 20 240 210" width={width} role="img" aria-label={label} style={{ maxWidth: '80vw', height: 'auto' }}>
      <defs>
        <linearGradient id="koB" x1="0" x2="1">
          <stop offset="0" className="k6" />
          <stop offset=".35" className="k1" />
          <stop offset=".7" className="k3" />
          <stop offset="1" className="k6" />
        </linearGradient>
        <radialGradient id="koD" cx=".5" cy=".9" r=".9">
          <stop offset="0" className="kd1" />
          <stop offset=".4" className="kd2" />
          <stop offset="1" className="kd3" />
        </radialGradient>
      </defs>
      <ellipse className="plinth" cx="160" cy="206" rx="110" ry="24" />
      <ellipse className="pool" cx="160" cy="214" rx="44" ry="8" />
      <g className="flt">
        <rect className="edge" x="149" y="32" width="22" height="26" rx="3" fill="url(#koB)" strokeWidth="1.4" />
        <path className="edge" d="M92 204V124a68 68 0 0 1 136 0v80z" fill="url(#koB)" strokeWidth="1.6" />
        <path className="ribs" d="M96 160q64-12 128 0M104 112q56-12 112 0" />
        <path className="edge door-glow" d="M140 204v-30a20 20 0 0 1 40 0v30z" fill="url(#koD)" strokeWidth="1.4" />
      </g>
    </svg>
  );
}
