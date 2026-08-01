import type { VideoState } from '@/lib/fixtures/pipeline';

/**
 * One glyph per pipeline state.
 *
 * State-at-a-glance: the screen bends around one status and the detail waits a layer
 * down. Scanning forty rows should be a shape-and-colour task, not a reading task, so
 * each state gets a distinct *silhouette* as well as a distinct hue — a ring reads
 * differently from a filled dot even at the edge of vision, and it still reads for
 * someone who cannot tell the hues apart.
 *
 * Colour comes from semantic `--state-*` tokens only. Nothing here knows what hue it is.
 */

const GLYPH: Record<VideoState, { shape: string; token: string }> = {
  drafting: { shape: 'ring-dashed', token: 'var(--state-drafting)' },
  generating: { shape: 'pulse', token: 'var(--state-generating)' },
  needs_review: { shape: 'ring', token: 'var(--state-review)' },
  blocked: { shape: 'square', token: 'var(--state-blocked)' },
  ready: { shape: 'dot', token: 'var(--state-ready)' },
  live: { shape: 'dot', token: 'var(--state-live)' },
  killed: { shape: 'slash', token: 'var(--state-killed)' },
};

export function StateGlyph({ state, size = 9 }: { state: VideoState; size?: number }) {
  const { shape, token } = GLYPH[state];
  const box = size + 2;

  if (shape === 'slash') {
    return (
      <svg
        width={box}
        height={box}
        viewBox="0 0 12 12"
        aria-hidden
        className="shrink-0"
        style={{ display: 'inline-block' }}
      >
        <line
          x1="2"
          y1="10"
          x2="10"
          y2="2"
          stroke={token}
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (shape === 'square') {
    return (
      <span
        aria-hidden
        className="shrink-0"
        style={{
          // display is explicit: a bare <span> is inline, and an inline box ignores
          // width/height entirely. The border then paints around a 0x0 box and renders
          // as a thin vertical bar. Found by measuring the DOM, not by reading the code.
          display: 'inline-block',
          width: size,
          height: size,
          background: token,
          borderRadius: 'var(--radius-xs)',
        }}
      />
    );
  }

  const isRing = shape === 'ring' || shape === 'ring-dashed';

  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 'var(--radius-full)',
        background: isRing ? 'transparent' : token,
        border: isRing ? `1.75px ${shape === 'ring-dashed' ? 'dashed' : 'solid'} ${token}` : undefined,
        // The single animated element in the product, and only for the one state where
        // motion carries meaning: something is happening right now. Killed entirely under
        // prefers-reduced-motion by the block in tokens.css.
        animation: shape === 'pulse' ? 'k-pulse 1.8s var(--ease-in-out) infinite' : undefined,
      }}
    />
  );
}

export function stateColorToken(state: VideoState): string {
  return GLYPH[state].token;
}
