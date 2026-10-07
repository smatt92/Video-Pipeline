'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  updateSeriesDefaultsAction,
  updateSlotAction,
  updateChannelFlagsAction,
  updateStillStyleAction,
  updateTuningAction,
} from '@/lib/settings/actions';
import type { ChannelFlags } from '@/lib/settings/channel-flags';
import type { Tuning, TuningKey } from '@/lib/settings/tuning';

/**
 * The editable parts of Settings → Generation, Assembly and Publishing. No optimistic apply:
 * these are values the next run reads, so a value shows as saved only once the action says
 * so, and a refusal is shown in its own words.
 */

type Result = { ok: true; message: string } | { ok: false; refused: string } | null;

function Outcome({ r }: { r: Result }) {
  if (!r) return null;
  return (
    <p className="xs" role="status" style={{ color: r.ok ? 'var(--t3)' : 'var(--blk-text)', marginTop: 6 }}>
      {r.ok ? r.message : r.refused}
    </p>
  );
}

type FieldKey = TuningKey | keyof ChannelFlags;

export type TuningField =
  | { key: FieldKey; label: string; help: string; kind: 'number'; min: number; max: number; step: number; unit?: string; builtIn: number }
  | { key: FieldKey; label: string; help: string; kind: 'boolean'; builtIn: boolean; labels?: { on: string; off: string } }
  | { key: FieldKey; label: string; help: string; kind: 'select'; options: { value: string; label: string }[]; builtIn: string };

/**
 * A set of channel_policy fields saved together. Disabled (with the reason) before the
 * migration that added them. `target` picks the writer: the 0049 tuning or the 0051 flags,
 * which are read and written apart (settings/channel-flags.ts says why).
 */
export function TuningForm({
  channelId,
  fields,
  values,
  disabledReason,
  path,
  canEdit,
  target = 'tuning',
}: {
  channelId: string;
  fields: TuningField[];
  values: Partial<Record<FieldKey, string | number | boolean>>;
  disabledReason: string | null;
  path: string;
  canEdit: boolean;
  target?: 'tuning' | 'flags';
}) {
  const initial = Object.fromEntries(fields.map((f) => [f.key, String(values[f.key])]));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const disabled = !!disabledReason || !canEdit;

  const save = () =>
    start(async () => {
      const patch: Record<string, unknown> = {};
      for (const f of fields) {
        const v = draft[f.key];
        if (v === initial[f.key]) continue;
        patch[f.key] = f.kind === 'number' ? Number(v) : f.kind === 'boolean' ? v === 'true' : v;
      }
      if (!Object.keys(patch).length) {
        setResult({ ok: true, message: 'Nothing changed.' });
        return;
      }
      const r = target === 'flags' ? await updateChannelFlagsAction(channelId, patch as Partial<ChannelFlags>, path) : await updateTuningAction(channelId, patch as Partial<Tuning>, path);
      setResult(r);
      if (r.ok) router.refresh();
    });

  return (
    <div className="col" style={{ gap: 0 }}>
      {fields.map((f) => (
        <div key={f.key} className="srow">
          <div style={{ minWidth: 0 }}>
            <label className="sm" style={{ fontWeight: 500 }} htmlFor={`t-${f.key}`}>
              {f.label}
            </label>
            <div className="xs t3" style={{ marginTop: 3 }}>
              {f.help} Built-in: <span className="mono">{f.kind === 'boolean' && f.labels ? (f.builtIn ? f.labels.on : f.labels.off) : String(f.builtIn)}{f.kind === 'number' && f.unit ? ` ${f.unit}` : ''}</span>.
            </div>
          </div>
          <div className="row" style={{ minWidth: 0 }}>
            {f.kind === 'number' ? (
              <>
                <input
                  id={`t-${f.key}`}
                  className="input mono"
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={draft[f.key]}
                  disabled={disabled}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  style={{ width: '12ch' }}
                />
                <span className="xs t3">
                  {f.unit ? `${f.unit} · ` : ''}
                  {f.min}–{f.max}
                </span>
              </>
            ) : f.kind === 'boolean' ? (
              <select id={`t-${f.key}`} className="input" value={draft[f.key]} disabled={disabled} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} style={{ width: '14ch' }}>
                <option value="false">{f.labels?.off ?? 'No'}</option>
                <option value="true">{f.labels?.on ?? 'Yes'}</option>
              </select>
            ) : (
              <select id={`t-${f.key}`} className="input" value={draft[f.key]} disabled={disabled} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}
      <div className="row" style={{ paddingTop: 12 }}>
        <button type="button" className="btn pri" onClick={save} disabled={disabled || pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {disabledReason && <span className="xs t3">{disabledReason}</span>}
        {!disabledReason && !canEdit && <span className="xs t3">Only the approver can change these.</span>}
      </div>
      <Outcome r={result} />
    </div>
  );
}

export function SlotForm({ channelId, slotTime, timezone, zones }: { channelId: string; slotTime: string; timezone: string; zones: string[] }) {
  const [time, setTime] = useState(slotTime.slice(0, 5));
  const [tz, setTz] = useState(timezone);
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="col">
      <div className="row">
        <div className="field" style={{ width: '12ch' }}>
          <label htmlFor="slot-time">Time</label>
          <input id="slot-time" className="input mono" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="slot-tz">Time zone</label>
          <input id="slot-tz" className="input mono" list="slot-zones" value={tz} onChange={(e) => setTz(e.target.value)} spellCheck={false} />
          <datalist id="slot-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn pri"
          disabled={pending || (time === slotTime.slice(0, 5) && tz === timezone)}
          onClick={() =>
            start(async () => {
              const r = await updateSlotAction(channelId, { slotTime: time, timezone: tz });
              setResult(r);
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save slot time'}
        </button>
      </div>
      <Outcome r={result} />
    </div>
  );
}

export function SeriesDefaultsRow({
  channelId,
  seriesId,
  format,
  pace,
  formats,
  paces,
  editable,
  motion,
  motions,
}: {
  channelId: string;
  seriesId: string;
  format: string;
  pace: string;
  formats: { value: string; label: string }[];
  paces: { value: string; label: string }[];
  editable: boolean;
  /** The 3D explainer's motion default (0052). Shown with that video type only. */
  motion?: string;
  motions?: { value: string; label: string }[];
}) {
  const [f, setF] = useState(format);
  const [p, setP] = useState(pace);
  const [m, setM] = useState(motion ?? 'key');
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row">
        <select aria-label="Video type" className="input" style={{ width: 'auto' }} value={f} disabled={!editable} onChange={(e) => setF(e.target.value)}>
          {formats.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select aria-label="Voice pace" className="input" style={{ width: 'auto' }} value={p} disabled={!editable} onChange={(e) => setP(e.target.value)}>
          {paces.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {f === 'engineered' && motions && (
          <select aria-label="Motion" className="input" style={{ width: 'auto' }} value={m} disabled={!editable} onChange={(e) => setM(e.target.value)}>
            {motions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={!editable || pending || (f === format && p === pace && m === (motion ?? 'key'))}
          onClick={() =>
            start(async () => {
              const r = await updateSeriesDefaultsAction(channelId, seriesId, { ...(f !== format ? { visual_format: f } : {}), ...(p !== pace ? { voice_pace: p } : {}), ...(m !== (motion ?? 'key') && f === 'engineered' ? { motion: m } : {}) });
              setResult(r);
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Outcome r={result} />
    </div>
  );
}

export function StillStyleForm({ channelId, current, max, editable }: { channelId: string; current: string; max: number; editable: boolean }) {
  const [v, setV] = useState(current);
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const len = v.trim().length;
  return (
    <div className="col">
      <textarea aria-label="Picture style" className="input" value={v} maxLength={max + 50} disabled={!editable} onChange={(e) => setV(e.target.value)} rows={3} />
      <div className="row sb">
        <span className="xs" style={{ color: len > max || len === 0 ? 'var(--blk-text)' : 'var(--t3)' }}>
          {len} / {max} characters{len === 0 ? ' — cannot be empty' : ''}
        </span>
        <button
          type="button"
          className="btn pri"
          disabled={!editable || pending || v === current}
          onClick={() =>
            start(async () => {
              const r = await updateStillStyleAction(channelId, v);
              setResult(r);
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save style'}
        </button>
      </div>
      <Outcome r={result} />
    </div>
  );
}
