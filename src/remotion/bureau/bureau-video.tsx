import { AbsoluteFill, Audio, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';

import type { CaptionCue } from '@/lib/review/timeline';

import { PAPER, projectOverlay, type OverlaySpec } from './overlay-scene';

/**
 * The Bureau of Reality composition. One component, three layers (renders.layer):
 *
 *   composite      shots + VO + English captions + hook — the cut Sahil approves
 *   clean_master   shots + VO, NO text — the base every language is built on
 *   caption_layer  text only, transparent — one per language, laid over the master
 *
 * Shots are either clips (generated, ingested, presigned http URLs) or overlays (chalk-line
 * Three.js scenes projected to SVG — see overlay-scene.ts for why not WebGL).
 */

export type BureauShot =
  | { type: 'clip'; url: string; frames: number; /** 'contain' pillarboxes a 9:16 master inside a 16:9 long-form. */ fit?: 'cover' | 'contain' }
  | { type: 'overlay'; overlay: OverlaySpec; frames: number };

export type BureauLayer = 'composite' | 'clean_master' | 'caption_layer';

export type BureauVideoProps = {
  layer: BureauLayer;
  shots: BureauShot[];
  /** The VO track (presigned). Omitted on a caption layer. */
  audioUrl: string | null;
  musicUrl: string | null;
  cues: CaptionCue[];
  hook: { text: string; startS: number; endS: number } | null;
  safeBox: { x: number; y: number; width: number; height: number };
};

export function BureauVideo(props: BureauVideoProps) {
  const { height } = useVideoConfig();
  const transparent = props.layer === 'caption_layer';
  const withText = props.layer !== 'clean_master';
  let start = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: transparent ? 'transparent' : PAPER.paper }}>
      {!transparent &&
        props.shots.map((s, i) => {
          const from = start;
          start += s.frames;
          if (s.frames <= 0) return null;
          return (
            <Sequence key={i} from={from} durationInFrames={s.frames}>
              {s.type === 'clip' ? <OffthreadVideo src={s.url} muted style={{ width: '100%', height: '100%', objectFit: s.fit ?? 'cover' }} /> : <Overlay spec={s.overlay} frames={s.frames} />}
            </Sequence>
          );
        })}
      {!transparent && props.audioUrl && <Audio src={props.audioUrl} />}
      {!transparent && props.musicUrl && <Audio src={props.musicUrl} volume={0.12} />}
      {withText && <Captions cues={props.cues} box={props.safeBox} fontSize={Math.round(height * 0.032)} />}
      {withText && props.hook && <Hook hook={props.hook} box={props.safeBox} fontSize={Math.round(height * 0.05)} />}
    </AbsoluteFill>
  );
}

function Grid({ width, height }: { width: number; height: number }) {
  const step = Math.round(width / 18);
  const lines = [];
  for (let x = step; x < width; x += step) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} />);
  for (let y = step; y < height; y += step) lines.push(<line key={`y${y}`} x1={0} y1={y} x2={width} y2={y} />);
  return <g stroke={PAPER.grid} strokeWidth={1} opacity={0.6}>{lines}</g>;
}

function Overlay({ spec, frames }: { spec: OverlaySpec; frames: number }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scene = projectOverlay(spec, frames > 1 ? frame / (frames - 1) : 1, width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER.paper }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Grid width={width} height={height} />
        {scene.paths.map((p, i) => (
          <polyline
            key={i}
            points={p.points.map(([x, y]) => `${x},${y}`).join(' ') + (p.closed && p.points[0] ? ` ${p.points[0][0]},${p.points[0][1]}` : '')}
            fill="none"
            stroke={p.color}
            strokeWidth={p.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {scene.dots.map((d, i) => (
          <circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r} fill={d.color} />
        ))}
      </svg>
    </AbsoluteFill>
  );
}

const textStyle = (fontSize: number, weight: number) => ({
  fontFamily: 'sans-serif',
  fontWeight: weight,
  fontSize,
  lineHeight: 1.2,
  color: PAPER.chalk,
  textAlign: 'center' as const,
  textShadow: '0 2px 10px rgba(11,31,58,0.95), 0 0 3px rgba(11,31,58,1)',
});

function Captions({ cues, box, fontSize }: { cues: CaptionCue[]; box: BureauVideoProps['safeBox']; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cue = cues.find((c) => t >= c.startS && t < c.endS);
  if (!cue) return null;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <span style={textStyle(fontSize, 700)}>{cue.text}</span>
    </div>
  );
}

function Hook({ hook, box, fontSize }: { hook: NonNullable<BureauVideoProps['hook']>; box: BureauVideoProps['safeBox']; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < hook.startS || t >= hook.endS) return null;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.width, display: 'flex', justifyContent: 'center' }}>
      <span style={textStyle(fontSize, 800)}>{hook.text}</span>
    </div>
  );
}
