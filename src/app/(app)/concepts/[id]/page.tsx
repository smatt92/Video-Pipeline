import { notFound } from 'next/navigation';

import { Panel, SectionHeader } from '@/components/settings/parts';
import { serverClient } from '@/lib/db/server';

/**
 * One concept, its script, and the state of every shot.
 *
 * The screen Gate 4 is watched from. It has to be honest about three things that are easy
 * to render optimistically: a shot that cannot be generated, a shot whose duration is still
 * a guess, and a cost that is not knowable.
 */

export const dynamic = 'force-dynamic';

const STATE_TOKEN: Record<string, string> = {
  pending: 'var(--state-drafting)',
  generating: 'var(--state-generating)',
  ready: 'var(--state-live)',
  failed: 'var(--state-blocked)',
  reshoot: 'var(--state-review)',
};

export default async function ConceptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serverClient();

  const { data: concept } = await db
    .from('concepts')
    .select('id, title, angle, status, channels(name, platform)')
    .eq('id', id)
    .maybeSingle();

  if (!concept) notFound();

  const { data: script } = await db
    .from('scripts')
    .select('id, version, hook, vo_text, structure_hash, human_edit_count')
    .eq('concept_id', id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: shots } = script
    ? await db
        .from('shots')
        .select('id, idx, description, shot_kind, duration_s, duration_source, status, compile_note, compiled_params')
        .eq('script_id', script.id)
        .order('idx')
    : { data: null };

  const { data: generations } = script
    ? await db
        .from('generations')
        .select('id, shot_id, kind, status, cost_inr, error_code, error_detail, confirmed_at, webhook_received_at, parent_generation_id')
        .in('shot_id', (shots ?? []).map((s) => s.id))
    : { data: null };

  // Unpriced is a state, not a zero. A generation whose rate was unverified carries a null
  // cost, and rendering that as ₹0 would report a real cost of nothing.
  const byShot = new Map<string, typeof generations>();
  for (const g of generations ?? []) {
    if (!g.shot_id) continue;
    byShot.set(g.shot_id, [...(byShot.get(g.shot_id) ?? []), g]);
  }

  const anyUnpriced = (generations ?? []).some((g) => g.cost_inr === null);
  const totalInr = (generations ?? []).reduce((n, g) => n + Number(g.cost_inr ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader title={concept.title} hint={concept.angle} />

      {!script ? (
        <Panel>
          <p className="px-4 py-4 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            No script yet. Stage 3 drafts one from this concept and its angle.
          </p>
        </Panel>
      ) : (
        <>
          <Panel className="mb-6">
            <div
              className="flex flex-wrap items-baseline gap-3 border-b px-4 py-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="text-[13.5px] font-medium">Script v{script.version}</span>
              <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {script.structure_hash.slice(0, 12)}…
              </span>
              <span
                className="font-mono text-[10.5px]"
                style={{
                  color:
                    script.human_edit_count > 0 ? 'var(--state-live)' : 'var(--state-review)',
                }}
              >
                {script.human_edit_count} human edit{script.human_edit_count === 1 ? '' : 's'}
                {script.human_edit_count === 0 && ' · publish is blocked until this is > 0'}
              </span>
            </div>
            <p className="px-4 py-3 text-[13px] leading-relaxed">{script.hook}</p>
          </Panel>

          <Panel>
            <div
              className="flex flex-wrap items-baseline gap-3 border-b px-4 py-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="text-[13.5px] font-medium">Shots</span>
              <span className="ml-auto font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {anyUnpriced
                  ? `unpriced · ${generations?.length ?? 0} generations, no verified rate`
                  : `₹${totalInr.toFixed(2)} across ${generations?.length ?? 0} generations`}
              </span>
            </div>

            {(shots ?? []).length === 0 ? (
              <p className="px-4 py-4 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                No shots yet. Stage 4 breaks the script into them.
              </p>
            ) : (
              (shots ?? []).map((shot) => {
                const gens = byShot.get(shot.id) ?? [];
                const generatable = Boolean(shot.compiled_params);
                const estimated = shot.duration_source !== 'derived_from_vo';

                return (
                  <div
                    key={shot.id}
                    className="border-b px-4 py-3 last:border-b-0"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
                      <span
                        aria-hidden
                        className="inline-block size-[7px] shrink-0 rounded-full"
                        style={{ background: STATE_TOKEN[shot.status] ?? 'var(--state-drafting)' }}
                      />
                      <span className="font-mono" style={{ color: 'var(--text-faint)' }}>
                        {shot.idx} · {shot.shot_kind ?? 'no kind'} · {Number(shot.duration_s)}s
                      </span>
                      {/* An estimated duration is not the same as a measured one, and video
                          generated against a guess is what the audio-first ordering exists
                          to prevent. Labelled rather than rendered identically. */}
                      {estimated && (
                        <span style={{ color: 'var(--state-review)' }}>estimated, not measured</span>
                      )}
                      <span className="ml-auto font-mono" style={{ color: 'var(--text-faint)' }}>
                        {shot.status}
                      </span>
                    </div>

                    <p className="mt-1 max-w-[80ch] text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {shot.description}
                    </p>

                    {!generatable && (
                      <p className="mt-1 max-w-[80ch] text-[11px]" style={{ color: 'var(--text-faint)' }}>
                        {shot.compile_note ?? 'Not compiled — no library recipe.'}
                      </p>
                    )}

                    {gens.map((g) => (
                      <p
                        key={g.id}
                        className="mt-1 font-mono text-[11px]"
                        style={{ color: 'var(--text-faint)' }}
                      >
                        {g.kind} · {g.status}
                        {g.parent_generation_id ? ' · chained from a still' : ''}
                        {' · '}
                        {/* Three states, not two. A confirmed completion and a merely
                            claimed one are different facts, and only the first licenses an
                            asset. */}
                        {g.confirmed_at
                          ? 'confirmed'
                          : g.webhook_received_at
                            ? 'callback received, unconfirmed'
                            : 'no callback yet'}
                        {' · '}
                        {g.cost_inr === null ? 'unpriced' : `₹${Number(g.cost_inr).toFixed(2)}`}
                        {g.error_detail ? ` · ${g.error_detail}` : ''}
                      </p>
                    ))}

                    <button
                      type="button"
                      disabled={!generatable}
                      className="mt-2 rounded-sm px-[10px] py-[4px] text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed"
                      style={{
                        background: generatable ? 'var(--accent)' : 'var(--surface-2)',
                        color: generatable ? 'var(--accent-contrast)' : 'var(--text-faint)',
                        transitionDuration: 'var(--duration-fast)',
                      }}
                    >
                      Regenerate
                    </button>
                  </div>
                );
              })
            )}
          </Panel>

          <p className="mt-4 max-w-[80ch] text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            Regenerate is inert until Gate 4. It bumps the attempt counter, which mints a new
            idempotency key and therefore a new charge — so it is wired only once a real
            submit has been watched end to end.
          </p>
        </>
      )}
    </div>
  );
}
