import 'server-only';

import { isVideoRoute } from '../bureau/estimate';
import { formatOptions } from '../bureau/format-estimates';
import { MOTION_LEVELS, VISUAL_FORMATS, type MotionLevel, type VisualFormat } from '../bureau/formats';
import type { Db } from '../db/server';
import { storage } from '../storage';

/**
 * What the Kiln Glass Studio screen shows besides the conversation: the session episode's
 * shots as a filmstrip, and the price of each video type against the per-Short cap.
 *
 * Pictures reach the browser as presigned GET URLs (CLAUDE.md rule 2 — URLs through Vercel,
 * never bytes). There is no full-bleed picture behind the controls (Sahil, 08-Oct, design
 * README): text over an arbitrary generated frame cannot be held to the contrast bar the
 * glass meets, so frames appear only as filmstrip thumbnails.
 */

export interface StripShot {
  id: string;
  idx: number;
  route: string | null;
  /** The narration this shot carries (the script's words between its character offsets). */
  line: string;
  status: string;
  durationS: number | null;
  /** Newest succeeded picture or clip, presigned; null when none exists yet (or it could not be signed). */
  thumb: { url: string; kind: 'image' | 'video' } | null;
  /** A clip can be re-rolled from here; a picture is redrawn on Cuts. */
  reroll: boolean;
}

export async function filmstrip(db: Db, scriptId: string): Promise<StripShot[] | null> {
  const [{ data: shots, error }, { data: script }] = await Promise.all([
    db.from('shots').select('id, idx, render_route, status, description, duration_s, effective_duration_s, vo_char_start, vo_char_end').eq('script_id', scriptId).order('idx'),
    db.from('scripts').select('vo_text').eq('id', scriptId).maybeSingle(),
  ]);
  if (error) return null;
  const list = shots ?? [];
  if (!list.length) return [];
  const { data: gens } = await db
    .from('generations')
    .select('id, shot_id, kind, completed_at')
    .in('shot_id', list.map((s) => s.id))
    .eq('status', 'succeeded')
    .in('kind', ['image', 'video'])
    .order('completed_at', { ascending: false });
  const newest = new Map<string, { id: string; kind: 'image' | 'video' }>();
  for (const g of gens ?? []) if (g.shot_id && !newest.has(g.shot_id)) newest.set(g.shot_id, { id: g.id, kind: g.kind === 'video' ? 'video' : 'image' });
  const genIds = [...newest.values()].map((g) => g.id);
  const { data: assets } = genIds.length ? await db.from('assets').select('generation_id, storage_key, kind').in('generation_id', genIds).in('kind', ['image', 'video']) : { data: [] };
  const keyOf = new Map((assets ?? []).map((a) => [a.generation_id as string, a.storage_key as string]));
  const vo = script?.vo_text ?? '';
  return Promise.all(
    list.map(async (s) => {
      const g = newest.get(s.id);
      const key = g ? keyOf.get(g.id) : undefined;
      const url = key ? await storage().presignGet({ key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null;
      const line = s.vo_char_start !== null && s.vo_char_end !== null && vo ? vo.slice(s.vo_char_start, s.vo_char_end).trim() : s.description;
      const dur = s.effective_duration_s ?? s.duration_s;
      return {
        id: s.id,
        idx: s.idx,
        route: s.render_route,
        line,
        status: s.status,
        durationS: dur === null ? null : Number(dur),
        thumb: url && g ? { url, kind: g.kind } : null,
        reroll: isVideoRoute(s.render_route),
      };
    }),
  );
}

export interface StudioPrices {
  /** Per type: the estimate, or null (unpriced — never ₹0), and why it is unavailable. */
  types: Record<VisualFormat, { inr: number | null; disabled: string | null; note: string | null }>;
  /** The 3D explainer at each motion level; null when it could not be priced. */
  motions: Record<MotionLevel, number | null> | null;
}

/**
 * Every type priced for the session's newest brief — the same `formatOptions` figures
 * Approvals and the session's own price_brief tool use. Null when there is no brief yet:
 * nothing exists to price, and the panel says so rather than showing a number.
 */
export async function studioPrices(db: Db, channelId: string, briefId: string): Promise<StudioPrices | null> {
  const { data: b } = await db.from('briefs').select('series, shot_list, script_text, lead_character, hero_objects').eq('id', briefId).maybeSingle();
  if (!b) return null;
  try {
    const r = await formatOptions(db, channelId, b as never);
    const types = Object.fromEntries(
      VISUAL_FORMATS.map((f) => {
        const o = r.options.find((x) => x.format === f);
        return [f, { inr: o?.inr ?? null, disabled: o?.disabled ?? null, note: o?.note ?? null }];
      }),
    ) as StudioPrices['types'];
    const motions = r.motions.length ? (Object.fromEntries(MOTION_LEVELS.map((m) => [m, r.motions.find((x) => x.motion === m)?.inr ?? null])) as Record<MotionLevel, number | null>) : null;
    return { types, motions };
  } catch {
    return null;
  }
}
