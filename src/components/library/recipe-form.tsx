'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { LibraryState } from '@/lib/prompts/actions';
import { reinstateRecipeAction, retireRecipeAction, saveRecipeAction } from '@/lib/prompts/actions';
import type { Recipe } from '@/lib/prompts/library';
import { SHOT_KINDS } from '@/lib/shots/kinds';

const IDLE: LibraryState = { status: 'idle' };

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: 'var(--accent)',
        color: 'var(--accent-contrast)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      {pending ? busy : label}
    </button>
  );
}

function Result({ state }: { state: LibraryState }) {
  if (state.status === 'idle') return null;
  const tone = state.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)';
  return (
    <div className="flex flex-col gap-1">
      {state.message && (
        <p className="text-[12px] leading-relaxed" style={{ color: tone }}>
          {state.message}
        </p>
      )}
      {state.problems?.map((p) => (
        <p key={p} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          · {p}
        </p>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-[0.09em]"
      style={{ color: 'var(--text-faint)' }}
    >
      {children}
    </span>
  );
}

const inputStyle = {
  background: 'var(--surface-inset)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-primary)',
};

/**
 * Where an exploratory session's findings land.
 *
 * The `params` field is a raw JSON textarea rather than a set of typed inputs, and that is
 * deliberate. The point is to capture *exactly* what was submitted to the vendor, verbatim —
 * a form with named fields silently drops any parameter the form does not know about, which
 * is precisely the parameter that made the recipe work.
 */
export function RecipeForm({ drivers }: { drivers: string[] }) {
  const [state, action] = useActionState(saveRecipeAction, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-[5px]">
          <Label>Name</Label>
          <input
            name="name"
            required
            placeholder="macro push-in, warm"
            className="rounded-sm border px-[10px] py-[7px] text-[13px] outline-none"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-[5px]">
          <Label>Driver</Label>
          <input
            name="driver"
            required
            list="known-drivers"
            defaultValue={drivers[0] ?? ''}
            className="rounded-sm border px-[10px] py-[7px] font-mono text-[12.5px] outline-none"
            style={inputStyle}
          />
          <datalist id="known-drivers">
            {drivers.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-[5px]">
          <Label>Model</Label>
          <input
            name="model"
            required
            placeholder="dop-turbo"
            className="rounded-sm border px-[10px] py-[7px] font-mono text-[12.5px] outline-none"
            style={inputStyle}
          />
        </label>
      </div>

      <label className="flex flex-col gap-[5px]">
        <Label>Template</Label>
        <textarea
          name="template"
          required
          rows={3}
          defaultValue="{{description}}"
          className="rounded-sm border px-[10px] py-[7px] font-mono text-[12.5px] outline-none"
          style={inputStyle}
        />
        <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {'Available: {{description}}, {{intent}}, {{duration}}. {{description}} is required — '}
          without it every shot sends the same prompt. An unfilled placeholder reaches the
          vendor verbatim and is billed as a clip of the literal words.
        </span>
      </label>

      <label className="flex flex-col gap-[5px]">
        <Label>Params — exactly what you submitted</Label>
        <textarea
          name="params"
          required
          rows={6}
          placeholder={'{\n  "motion_id": "…",\n  "aspect_ratio": "9:16",\n  "quality": "high",\n  "seed": 12345\n}'}
          className="rounded-sm border px-[10px] py-[7px] font-mono text-[12px] outline-none"
          style={inputStyle}
        />
        <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          Raw JSON, verbatim, not a summary. A typed form would drop any parameter it does
          not know about — which is exactly the one that made the recipe work. Refused if
          empty: a recipe that cannot reproduce its own sample is worse than no recipe.
        </span>
      </label>

      <fieldset className="flex flex-col gap-[6px]">
        <Label>Serves which shot kinds</Label>
        <div className="flex flex-col gap-[6px]">
          {SHOT_KINDS.map((k) => (
            <label key={k.key} className="flex items-start gap-2 text-[12.5px]">
              <input type="checkbox" name="tags" value={k.key} className="mt-[3px]" />
              <span>
                <span className="font-mono text-[11.5px]">{k.key}</span>
                <span style={{ color: 'var(--text-faint)' }}> — {k.note}</span>
              </span>
            </label>
          ))}
        </div>
        <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          At least one. This is the matching key — a recipe with no kinds matches no shot.
        </span>
      </fieldset>

      <label className="flex items-start gap-2 text-[12.5px]">
        <input type="checkbox" name="accepts_character_ref" className="mt-[3px]" />
        <span>
          Carries a character reference
          <span className="block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            Only tick this if you watched the clip and the person was the right person.
            Compilation refuses to use a recipe without it for a shot that has a character,
            and a wrongly ticked box turns that refusal into a stranger in the video.
            Orthogonal to shot kind — a character can appear in any framing.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-[5px]">
          <Label>Sample output URL</Label>
          <input
            name="sample_output_url"
            placeholder="https://…"
            className="rounded-sm border px-[10px] py-[7px] text-[12.5px] outline-none"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-[5px]">
          <Label>Discovered in</Label>
          <select
            name="discovered_in"
            defaultValue="claude-code-mcp"
            className="rounded-sm border px-[10px] py-[7px] text-[12.5px] outline-none"
            style={inputStyle}
          >
            <option value="claude-code-mcp">claude-code-mcp</option>
            <option value="manual">manual</option>
            <option value="imported">imported</option>
          </select>
        </label>
      </div>

      <div>
        <Submit label="Save recipe" busy="Saving…" />
      </div>
      <Result state={state} />
    </form>
  );
}

export function RecipeRow({ recipe }: { recipe: Recipe }) {
  const [retireState, retire] = useActionState(retireRecipeAction.bind(null, recipe.id), IDLE);
  const [reinstateState, reinstate] = useActionState(
    reinstateRecipeAction.bind(null, recipe.id),
    IDLE,
  );

  return (
    <div
      className="border-b px-4 py-3"
      style={{ borderColor: 'var(--border-subtle)', opacity: recipe.isActive ? 1 : 0.6 }}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-[13px] font-medium">{recipe.name}</span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          v{recipe.version} · {recipe.driver}/{recipe.model}
        </span>
        <span
          className="rounded-xs px-[6px] py-[2px] font-mono text-[10px] uppercase"
          style={{
            background: 'var(--surface-2)',
            color: recipe.isActive ? 'var(--state-live)' : 'var(--text-faint)',
          }}
        >
          {recipe.isActive ? 'active' : 'retired'}
        </span>
        <span className="ml-auto font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {recipe.winRate === null ? 'win rate unmeasured' : `${(recipe.winRate * 100).toFixed(0)}% win`}
          {' · '}
          compiled {recipe.timesCompiled}× · shipped {recipe.timesShipped}×
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-[5px]">
        {recipe.tags.map((t) => (
          <span
            key={t}
            className="rounded-xs px-[6px] py-[2px] font-mono text-[10.5px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
          >
            {t}
          </span>
        ))}
        {recipe.acceptsCharacterRef && (
          <span
            className="rounded-xs px-[6px] py-[2px] font-mono text-[10.5px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            carries character ref
          </span>
        )}
        <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
          {recipe.discoveredIn ?? 'provenance unrecorded'}
        </span>
      </div>

      <pre
        className="mt-2 overflow-x-auto rounded-sm px-2 py-[6px] font-mono text-[11px] leading-relaxed"
        style={{ background: 'var(--surface-inset)', color: 'var(--text-secondary)' }}
      >
        {recipe.template}
        {'\n'}
        {JSON.stringify(recipe.params, null, 2)}
      </pre>

      {recipe.retiredReason && (
        <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {recipe.retiredReason}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        {recipe.isActive ? (
          <form action={retire} className="flex items-center gap-2">
            <input
              name="reason"
              placeholder="why retire it"
              className="w-[220px] rounded-sm border bg-transparent px-2 py-[4px] text-[11.5px] outline-none"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            />
            <button
              type="submit"
              className="rounded-sm border px-[8px] py-[4px] text-[11.5px]"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
            >
              Retire
            </button>
          </form>
        ) : (
          <form action={reinstate}>
            <button
              type="submit"
              className="rounded-sm border px-[8px] py-[4px] text-[11.5px]"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
            >
              Reinstate
            </button>
          </form>
        )}
        <Result state={retireState.status !== 'idle' ? retireState : reinstateState} />
      </div>
    </div>
  );
}
