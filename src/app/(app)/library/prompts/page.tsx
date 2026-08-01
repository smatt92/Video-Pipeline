import { RecipeForm, RecipeRow } from '@/components/library/recipe-form';
import { Panel, SectionHeader } from '@/components/settings/parts';
import { serverClient } from '@/lib/db/server';
import { INTEGRATION_CATALOG } from '@/lib/drivers/catalog';
import { listRecipes, recipeGaps, unresolvedShots } from '@/lib/prompts/library';
import { shotKind } from '@/lib/shots/kinds';

/**
 * The prompt library — and the worklist that says what it is missing.
 *
 * This screen is the destination for an exploratory MCP session. Everything downstream of
 * stage 4 waits on recipes, and recipes can only come from someone watching real clips, so
 * the most useful thing this page can do is answer "what should I go and discover?" before
 * it answers anything else. Hence the gaps table first and the form last.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — prompt library' };

export default async function PromptLibraryPage() {
  const db = serverClient();
  const [recipes, gaps, blocked] = await Promise.all([
    listRecipes(db),
    recipeGaps(db),
    unresolvedShots(db),
  ]);

  const drivers = [
    ...new Set(INTEGRATION_CATALOG.filter((i) => i.kind === 'video').map((i) => i.slug)),
  ];
  const active = recipes.filter((r) => r.isActive).length;

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader
        title="Prompt library"
        hint="Recipes proven in an exploratory session. Production selects from here and never improvises — a prompt that has never produced a watchable clip is a guess that costs credits to disprove."
      />

      {/* ── The worklist ─────────────────────────────────────────────────── */}
      <Panel className="mb-6">
        <div
          className="flex items-baseline gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[13.5px] font-medium">What is blocked</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {blocked.length} shot{blocked.length === 1 ? '' : 's'} cannot compile · {active} active
            recipe{active === 1 ? '' : 's'}
          </span>
        </div>

        {gaps.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            {blocked.length === 0
              ? 'Nothing waiting. Every shot has compiled against a recipe.'
              : 'Shots are waiting, but none carries a shot kind — they were written before the vocabulary existed. Re-running stage 4 on their scripts assigns one.'}
          </p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ color: 'var(--text-faint)' }}>
                {['shot kind', 'shots', 'scripts', 'seconds', 'recipes'].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2 font-mono text-[9.5px] font-normal uppercase tracking-[0.08em] ${
                      i === 0 ? 'text-left' : 'text-right'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gaps.map((g) => {
                const kind = shotKind(g.shotKind);
                const unserved = g.activeRecipes === 0;
                return (
                  <tr key={g.shotKind} style={{ color: 'var(--text-secondary)' }}>
                    <td className="px-4 py-2 align-top">
                      <span
                        className="font-mono text-[11.5px]"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {g.shotKind}
                      </span>
                      {kind && (
                        <div
                          className="mt-[2px] max-w-[46ch] text-[11.5px]"
                          style={{ color: 'var(--text-faint)' }}
                        >
                          {kind.note}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right align-top font-mono">{g.shotsWaiting}</td>
                    <td className="px-4 py-2 text-right align-top font-mono">{g.scriptsBlocked}</td>
                    <td className="px-4 py-2 text-right align-top font-mono">
                      {g.secondsWaiting.toFixed(1)}s
                    </td>
                    <td
                      className="px-4 py-2 text-right align-top font-mono"
                      style={{ color: unserved ? 'var(--state-blocked)' : 'var(--state-live)' }}
                    >
                      {g.activeRecipes}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {gaps.some((g) => g.activeRecipes === 0) && (
          <p
            className="border-t px-4 py-3 text-[11.5px] leading-relaxed"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            A zero in the last column is a shot kind nothing serves yet, ordered by how much
            each is holding up. That is a queue for an exploratory session, not an error
            state.
          </p>
        )}
      </Panel>

      {/* ── The blocked shots themselves ─────────────────────────────────── */}
      {blocked.length > 0 && (
        <Panel className="mb-6">
          <div
            className="border-b px-4 py-3 text-[13.5px] font-medium"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            Shots waiting on a recipe
          </div>
          {blocked.slice(0, 20).map((s) => (
            <div
              key={s.shotId}
              className="border-b px-4 py-[10px] last:border-b-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
                <span className="font-mono" style={{ color: 'var(--text-faint)' }}>
                  {s.channelName} · shot {s.idx} · {s.durationS}s
                </span>
                <span
                  className="rounded-xs px-[5px] py-[1px] font-mono text-[10.5px]"
                  style={{
                    background: 'var(--surface-2)',
                    color: s.matchingRecipes > 0 ? 'var(--state-live)' : 'var(--state-blocked)',
                  }}
                >
                  {s.shotKind ?? 'no kind'}
                </span>
                <span style={{ color: 'var(--text-faint)' }}>{s.conceptTitle}</span>
              </div>
              <p
                className="mt-1 max-w-[80ch] text-[12px]"
                style={{ color: 'var(--text-secondary)' }}
              >
                {s.description}
              </p>
              {s.compileNote && (
                <p className="mt-1 max-w-[80ch] text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {s.compileNote}
                </p>
              )}
            </div>
          ))}
          {blocked.length > 20 && (
            <p className="px-4 py-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {blocked.length - 20} more not shown.
            </p>
          )}
        </Panel>
      )}

      {/* ── The library ──────────────────────────────────────────────────── */}
      <Panel className="mb-6">
        <div
          className="border-b px-4 py-3 text-[13.5px] font-medium"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          Recipes
        </div>
        {recipes.length === 0 ? (
          <p
            className="max-w-[80ch] px-4 py-4 text-[12.5px] leading-relaxed"
            style={{ color: 'var(--text-muted)' }}
          >
            Empty. Nothing downstream of stage 4 can run until something is here, and the
            only way something gets here is an exploratory session against the vendor,
            watching real clips. That is deliberate: a recipe is a claim that a parameter set
            produces watchable video, and only someone who watched it can make that claim.
          </p>
        ) : (
          recipes.map((r) => <RecipeRow key={r.id} recipe={r} />)
        )}
      </Panel>

      {/* ── Save ─────────────────────────────────────────────────────────── */}
      <Panel>
        <div
          className="border-b px-4 py-3 text-[13.5px] font-medium"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          Record a recipe
        </div>
        <div className="px-4 py-4">
          <RecipeForm drivers={drivers} />
        </div>
      </Panel>
    </div>
  );
}
