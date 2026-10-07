import type { CSSProperties } from 'react';

/**
 * Clay bust on blueprint (canvas: Approvals, Voices). The sphere colour is the cast member's;
 * a Bureau slug gets its canvas class (and the head variants — box, auditor, ohm, pip), any
 * other channel's cast passes its bible accent. Decorative: the name is always beside it.
 */
const VARIANT: Record<string, string> = { complaint_box: 'box', box: 'box', auditor: 'aud', ohm: 'ohm', pip: 'pip' };
const CLASS: Record<string, string> = { pip: 'c-pip', marlo: 'c-marlo', iyer: 'c-iyer', nib: 'c-nib', kaz: 'c-kaz', ohm: 'c-ohm', complaint_box: 'c-box', auditor: 'c-aud' };

export function Bust({ slug, accent, size = 'md', plate = true }: { slug: string; accent?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; plate?: boolean }) {
  const cls = CLASS[slug];
  const v = VARIANT[slug];
  return (
    <div
      className={['bust', size === 'xl' ? '' : size, plate && 'bp', v, cls].filter(Boolean).join(' ')}
      style={!cls && accent ? ({ '--c': accent } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      <div className="gl" />
      <div className="sh" />
      <div className="cl" />
      <div className="hd" />
    </div>
  );
}
