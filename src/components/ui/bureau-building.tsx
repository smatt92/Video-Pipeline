/**
 * The Bureau building (canvas: Home, BrandObject) — the channel's world, clay on a blueprint
 * plate. Channel level only: never on the same screen as the studio's kiln object.
 *
 * `lit` is how many windows are lit, and the caller passes a count from rows (episodes in
 * production), so the picture says something true rather than decorating.
 */
const WINDOWS = ["188.6,193.1 201.8,185.3 201.8,168.3 188.6,176.1", "188.6,167.1 201.8,159.3 201.8,142.3 188.6,150.1", "188.6,141.1 201.8,133.3 201.8,116.3 188.6,124.0", "210.4,180.4 223.7,172.7 223.7,155.7 210.4,163.4", "210.4,154.4 223.7,146.7 223.7,129.7 210.4,137.4", "210.4,128.4 223.7,120.7 223.7,103.7 210.4,111.4", "232.2,167.8 245.6,160.1 245.6,143.1 232.2,150.8", "232.2,141.8 245.6,134.1 245.6,117.1 232.2,124.8", "232.2,115.8 245.6,108.1 245.6,91.0 232.2,98.7", "254.1,155.1 267.4,147.4 267.4,130.4 254.1,138.1", "254.1,129.1 267.4,121.4 267.4,104.4 254.1,112.1", "254.1,103.1 267.4,95.4 267.4,78.4 254.1,86.1", "171.7,164.2 160.7,157.8 160.7,142.8 171.7,149.2", "171.7,139.2 160.7,132.8 160.7,117.8 171.7,124.2", "130.3,140.2 119.3,133.8 119.3,118.8 130.3,125.2", "130.3,115.2 119.3,108.8 119.3,93.8 130.3,100.2"] as const;

export function BureauBuilding({ lit = 0, sign = 'BUREAU·OF·REALITY', label = 'The Bureau building, clay on a blueprint plate' }: { lit?: number; sign?: string; label?: string }) {
  return (
    <svg className="bld" viewBox="40 0 320 270" role="img" aria-label={label}>
        <defs>
          <linearGradient id="kT" x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="k1" /><stop offset="1" className="k2" /></linearGradient>
          <linearGradient id="kR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="k3" /><stop offset="1" className="k4" /></linearGradient>
          <linearGradient id="kL" x1="1" y1="0" x2="0" y2="1"><stop offset="0" className="k5" /><stop offset="1" className="k6" /></linearGradient>
          <radialGradient id="kM" cx=".35" cy=".3" r=".8"><stop offset="0" className="k7" /><stop offset="1" className="k8" /></radialGradient>
        </defs>
        <polygon className="pls" points="55.1,176.4 175.9,246.4 175.9,256.4 55.1,186.4" />
        <polygon className="pls" points="175.9,246.4 330.9,156.6 330.9,166.6 175.9,256.4" />
        <polygon className="pl" points="175.9,246.4 330.9,156.6 210.1,86.6 55.1,176.4" />
        <polyline className="gl" points="201.7,231.4 81.0,161.4" /><polyline className="gl" points="227.5,216.5 106.8,146.5" /><polyline className="gl" points="253.4,201.5 132.6,131.5" /><polyline className="gl" points="279.2,186.5 158.5,116.5" /><polyline className="gl" points="305.0,171.6 184.3,101.6" />
        <polyline className="gl" points="151.7,232.4 306.7,142.6" /><polyline className="gl" points="127.6,218.4 282.6,128.6" /><polyline className="gl" points="103.4,204.4 258.4,114.6" /><polyline className="gl" points="79.3,190.4 234.3,100.6" />
        <ellipse className="orbit" cx="193" cy="118" rx="152" ry="44" transform="rotate(-14 193 118)" />
        <polygon className="sh" points="194,220 289,165 220,125 125,180" />
        <polygon className="fl e" points="111,174 180,214 180,114 111,74" />
        <polygon className="fr e" points="180,214 275,159 275,59 180,114" />
        <polygon className="ft e" points="180,114 275,59 206,19 111,74" />
        {WINDOWS.map((p, i) => <polygon key={p} className={`win${i < lit ? ' on' : ''}`} points={p} />)}
        <polygon className="door" points="155.8,200.0 135.2,188.0 135.2,160.0 155.8,172.0" />
        <polygon className="sign" points="167.6,173.8 123.4,148.2 123.4,141.2 167.6,166.8" />
        <text className="st" transform="matrix(0.866 0.5 0 1 126 146.6)">{sign}</text>
        <path className="mast" d="M193 66 V36 M187 44 H199 M189 50 H197" />
        <circle className="beacon" cx="193" cy="33" r="2.8" />
        <g className="float"><circle className="moon" cx="322" cy="54" r="13" /><path className="moonline" d="M309 62 L282 74" /></g>
      </svg>
  );
}
