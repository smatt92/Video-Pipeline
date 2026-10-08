import { interpolate, Easing, useCurrentFrame, useVideoConfig } from 'remotion';

import { CIRCLED, KEYWORD_COLOURS, type ShotGraphics } from '../../lib/bureau/graphics';
import type { KeywordCue } from '../../lib/bureau/engineered-captions';

/**
 * The 3D explainer's graphics layer (0052) — drawn by us over the pictures, never by a model.
 *
 *   badge     top-left of the safe box: a dark pill, the attempt number in a yellow ring
 *   verdict   under the badge: ✓ green / ✗ red-orange, a bold line and a smaller sub-line
 *   callouts  a dot on the named part, a leader line, a label pill toward the frame's centre
 *   meters    a horizontal bar in the lower third: label, animated fill, value text
 *   captions  2–4 words, centred low-middle, heavy, white with a dark shadow, one word coloured
 *
 * Every position is inside `box` (the platform's safe area: the right rail and the bottom
 * caption bar are outside it). A model-chosen coordinate is clamped into it, never trusted.
 * Sizes are fractions of the frame height, like the Bureau's captions, so a re-sized render
 * keeps the proportions.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const INK = 'rgba(12,18,28,0.88)';
const YELLOW = '#FFD23F';
const PASS = '#22C55E';
const FAIL = '#FF5A36';
const FONT = '"Nunito Black", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif';
const SHADOW = '0 3px 12px rgba(0,0,0,0.85), 0 0 3px rgba(0,0,0,0.9)';

/** A 0→1 pop over the first frames of a beat (scale and fade), so graphics land on the cut. */
function usePop(delayFrames = 0, frames = 7): number {
  const frame = useCurrentFrame();
  return interpolate(frame - delayFrames, [0, frames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(1.6)) });
}

/** Where the caption band starts, as a fraction of the safe box's height: low-middle of the frame. */
export const CAPTION_TOP = 0.64;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where a callout's dot goes, in pixels, always inside the box. Defaults spread down the middle. */
export function calloutPoint(c: { x?: number; y?: number }, i: number, box: Box, frame: { width: number; height: number }): { x: number; y: number } {
  const defaults = [
    [0.38, 0.42],
    [0.62, 0.5],
    [0.45, 0.58],
  ];
  const fx = c.x ?? defaults[i % 3][0];
  const fy = c.y ?? defaults[i % 3][1];
  // Above the caption band (which starts at CAPTION_TOP of the box) and below the badge/verdict.
  return { x: clamp(fx * frame.width, box.x + 24, box.x + box.width - 24), y: clamp(fy * frame.height, box.y + box.height * 0.2, box.y + box.height * (CAPTION_TOP - 0.06)) };
}

export function GraphicsLayer({ g, box, frames }: { g: ShotGraphics; box: Box; frames: number }) {
  const { width, height } = useVideoConfig();
  const unit = height / 1920;
  const badgeH = Math.round(84 * unit);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {g.badge && <Badge n={g.badge.n} label={g.badge.label} x={box.x} y={box.y} h={badgeH} unit={unit} />}
      {g.verdict && <Verdict v={g.verdict} x={box.x} y={box.y + (g.badge ? badgeH + Math.round(18 * unit) : 0)} unit={unit} maxW={box.width} />}
      {(g.callouts ?? []).map((c, i) => (
        <Callout key={i} label={c.label} at={calloutPoint(c, i, box, { width, height })} box={box} unit={unit} delay={4 + i * 4} />
      ))}
      {(g.meters ?? []).map((m, i) => (
        <Meter key={i} m={m} x={box.x + box.width * 0.06} y={box.y + box.height * 0.84 - i * Math.round(110 * unit)} w={box.width * 0.88} unit={unit} frames={frames} />
      ))}
    </div>
  );
}

function Badge({ n, label, x, y, h, unit }: { n: number; label: string; x: number; y: number; h: number; unit: number }) {
  const p = usePop();
  return (
    <div style={{ position: 'absolute', left: x, top: y, height: h, display: 'flex', alignItems: 'center', gap: Math.round(16 * unit), padding: `0 ${Math.round(28 * unit)}px 0 ${Math.round(10 * unit)}px`, background: INK, borderRadius: h, transform: `scale(${p})`, transformOrigin: 'left center', opacity: Math.min(1, p * 1.4) }}>
      <div style={{ width: h - Math.round(16 * unit), height: h - Math.round(16 * unit), borderRadius: '50%', border: `${Math.round(6 * unit)}px solid ${YELLOW}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: YELLOW, fontFamily: FONT, fontWeight: 900, fontSize: Math.round(40 * unit), lineHeight: 1 }}>{n}</div>
      <span style={{ color: '#FFFFFF', fontFamily: FONT, fontWeight: 900, fontSize: Math.round(40 * unit), letterSpacing: 1, whiteSpace: 'nowrap' }}>{label.toUpperCase()}</span>
    </div>
  );
}

/** The circled numeral for a badge, for any text-only surface (Cuts, the plan). */
export const circled = (n: number) => CIRCLED[n - 1] ?? String(n);

function Verdict({ v, x, y, unit, maxW }: { v: NonNullable<ShotGraphics['verdict']>; x: number; y: number; unit: number; maxW: number }) {
  const p = usePop(3);
  const colour = v.pass ? PASS : FAIL;
  return (
    <div style={{ position: 'absolute', left: x, top: y, maxWidth: maxW, display: 'flex', alignItems: 'center', gap: Math.round(16 * unit), padding: `${Math.round(14 * unit)}px ${Math.round(26 * unit)}px`, background: colour, borderRadius: Math.round(26 * unit), transform: `scale(${p})`, transformOrigin: 'left center', opacity: Math.min(1, p * 1.4), boxShadow: '0 6px 20px rgba(0,0,0,0.35)' }}>
      {/* Drawn, not typed: the render's font has no ✓/✗ and the first real cut showed a box (08-Oct). */}
      <svg width={Math.round(44 * unit)} height={Math.round(44 * unit)} viewBox="0 0 24 24" style={{ flex: 'none' }} aria-label={v.pass ? 'pass' : 'fail'}>
        {v.pass ? (
          <path d="M4 12.5 L9.5 18 L20 6" fill="none" stroke="#FFFFFF" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="#FFFFFF" strokeWidth={3.4} strokeLinecap="round" />
        )}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: '#FFFFFF', fontFamily: FONT, fontWeight: 900, fontSize: Math.round(40 * unit), lineHeight: 1.1, whiteSpace: 'nowrap' }}>{v.text.toUpperCase()}</span>
        {v.sub && <span style={{ color: 'rgba(255,255,255,0.92)', fontFamily: FONT, fontWeight: 700, fontSize: Math.round(26 * unit), lineHeight: 1.2 }}>{v.sub}</span>}
      </div>
    </div>
  );
}

function Callout({ label, at, box, unit, delay }: { label: string; at: { x: number; y: number }; box: Box; unit: number; delay: number }) {
  const p = usePop(delay);
  // The label sits up and toward the middle of the box from the dot, so it never leaves the box.
  const toRight = at.x < box.x + box.width / 2;
  const lx = clamp(at.x + (toRight ? 1 : -1) * 150 * unit, box.x + 10, box.x + box.width - 10);
  const ly = clamp(at.y - 150 * unit, box.y + box.height * 0.14, box.y + box.height * (CAPTION_TOP - 0.06));
  const dot = Math.round(14 * unit);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: Math.min(1, p * 1.5) }}>
      <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width="100%" height="100%">
        <line x1={at.x} y1={at.y} x2={at.x + (lx - at.x) * p} y2={at.y + (ly - at.y) * p} stroke="#FFFFFF" strokeWidth={Math.max(2, Math.round(4 * unit))} />
        <circle cx={at.x} cy={at.y} r={dot} fill={YELLOW} stroke="#FFFFFF" strokeWidth={Math.max(2, Math.round(4 * unit))} />
      </svg>
      <div style={{ position: 'absolute', left: lx, top: ly, transform: `translate(${toRight ? '0' : '-100%'}, -50%) scale(${p})`, transformOrigin: toRight ? 'left center' : 'right center', background: INK, border: `${Math.max(2, Math.round(3 * unit))}px solid #FFFFFF`, borderRadius: Math.round(14 * unit), padding: `${Math.round(8 * unit)}px ${Math.round(18 * unit)}px`, color: '#FFFFFF', fontFamily: FONT, fontWeight: 900, fontSize: Math.round(34 * unit), whiteSpace: 'nowrap' }}>{label.toUpperCase()}</div>
    </div>
  );
}

function Meter({ m, x, y, w, unit, frames }: { m: NonNullable<ShotGraphics['meters']>[number]; x: number; y: number; w: number; unit: number; frames: number }) {
  const frame = useCurrentFrame();
  const p = usePop(2);
  const from = m.value ?? m.from ?? 0;
  const to = m.value ?? m.to ?? from;
  const fill = interpolate(frame, [4, Math.max(5, frames - 6)], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const barH = Math.round(30 * unit);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - Math.min(1, p)) * 20 * unit}px)` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: Math.round(10 * unit), gap: Math.round(16 * unit) }}>
        <span style={{ color: '#FFFFFF', fontFamily: FONT, fontWeight: 900, fontSize: Math.round(32 * unit), textShadow: SHADOW, whiteSpace: 'nowrap' }}>{m.label.toUpperCase()}</span>
        <span style={{ color: YELLOW, fontFamily: FONT, fontWeight: 800, fontSize: Math.round(30 * unit), textShadow: SHADOW, whiteSpace: 'nowrap' }}>{m.unit}</span>
      </div>
      <div style={{ width: w, height: barH, background: INK, borderRadius: barH, border: `${Math.max(2, Math.round(3 * unit))}px solid rgba(255,255,255,0.85)`, overflow: 'hidden' }}>
        <div style={{ width: `${(clamp(fill, 0, 1) * 100).toFixed(2)}%`, height: '100%', background: YELLOW, borderRadius: barH }} />
      </div>
    </div>
  );
}

/** 2–4 words, centred low-middle in the safe box, the keyword in its role's colour. */
export function KeywordCaptions({ cues, box, fontSize }: { cues: KeywordCue[]; box: Box; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cue = cues.find((c) => t >= c.startS && t < c.endS);
  if (!cue) return null;
  const into = t - cue.startS;
  const pop = interpolate(into, [0, 0.12], [0.86, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(2)) });
  return (
    <div style={{ position: 'absolute', left: box.x, width: box.width, top: box.y + box.height * CAPTION_TOP, display: 'flex', justifyContent: 'center' }}>
      <span style={{ fontFamily: FONT, fontWeight: 900, fontSize, lineHeight: 1.15, textAlign: 'center', color: '#FFFFFF', textShadow: SHADOW, transform: `scale(${pop})`, display: 'inline-block' }}>
        {cue.words.map((w, i) => (
          <span key={i} style={{ color: cue.keyword?.index === i ? KEYWORD_COLOURS[cue.keyword.role] : '#FFFFFF' }}>
            {i ? ' ' : ''}
            {w.w.toUpperCase()}
          </span>
        ))}
      </span>
    </div>
  );
}
