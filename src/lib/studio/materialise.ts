import 'server-only';

import { createHash } from 'node:crypto';

import type { Db } from '../db/server';
import type { Json } from '../db/types';

/**
 * A Studio session becoming pipeline data.
 *
 * Addendum 01 §1 is the rule this implements, and it is the rule that keeps the Studio
 * lane from becoming a second codebase: *the Studio lane does not get its own tables. A
 * session materialises a `scripts` row on first generation.* Everything downstream —
 * shots, generations, assets, renders, reviews — is then identical to the pipeline lane,
 * and review, stitch, cost and the originality trail work with no special-casing.
 *
 * ── The concept the addendum does not mention ────────────────────────────────
 *
 * `scripts.concept_id` is NOT NULL. The addendum says a session materialises a script and
 * stops there, because in the pipeline lane a concept always already exists — stage 2 made
 * it. So a session has to materialise the concept too.
 *
 * That is evolution rather than a contradiction: nothing in the addendum says a script may
 * stand alone, it simply never encounters the case. And the concept row is not a
 * formality — `cost_ledger.concept_id`, `v_render_cost` and the whole cost-per-video
 * question are keyed through it, so a script hanging off nothing would be a video the
 * headline metric cannot see.
 *
 * The concept is created with `rubric_version = 'studio-session'` and no scores, which is
 * the honest record: this concept was not scored against the trend rubric, it was argued
 * for in a conversation. `status = 'in_production'` because materialising happens on first
 * generation — by then the decision to make it has been taken.
 *
 * ── Why not at session start ─────────────────────────────────────────────────
 *
 * Because most sessions should produce nothing. Exploring, rejecting, and stopping is the
 * lane working correctly, and a concepts row per exploration turns the originality
 * evidence in ARCHITECTURE.md §0.2 into a table of videos nobody decided to make. The
 * spend from those sessions is still recorded — 0017 gives it the session as a subject.
 */

export interface MaterialiseSeed {
  title?: string;
  angle?: string;
  voText?: string;
}

export type MaterialiseResult =
  | { ok: true; scriptId: string; conceptId: string; created: boolean }
  | { ok: false; code: string; detail: string; remedy: string };

export async function materialiseScript(
  db: Db,
  sessionId: string,
  seed: MaterialiseSeed,
): Promise<MaterialiseResult> {
  const { data: session } = await db
    .from('studio_sessions')
    .select('id, title, script_id, channel_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) {
    return {
      ok: false,
      code: 'unknown_session',
      detail: `No studio_sessions row ${sessionId}.`,
      remedy: 'Start a session from /studio.',
    };
  }

  // Already materialised. Idempotent by the session row, not by a name or a hash: a second
  // generate_shot in the same session must land on the same script, and two sessions about
  // the same idea are two scripts.
  if (session.script_id) {
    const { data: existing } = await db
      .from('scripts')
      .select('id, concept_id')
      .eq('id', session.script_id)
      .maybeSingle();

    if (existing) {
      return { ok: true, scriptId: existing.id, conceptId: existing.concept_id, created: false };
    }
    // The pointer survived the row. Falls through and makes a new one rather than
    // returning an id that resolves to nothing.
  }

  const channelId = session.channel_id ?? (await firstActiveChannel(db));
  if (!channelId) {
    return {
      ok: false,
      code: 'no_channel',
      detail:
        'A script hangs off a concept, and a concept hangs off a channel. This workspace ' +
        'has no active channel.',
      remedy: 'Finish onboarding step 8, which creates the channel.',
    };
  }

  const title = seed.title?.trim() || session.title?.trim() || 'Untitled Studio session';
  const angle =
    seed.angle?.trim() ||
    'Decided in conversation. See the session transcript for the editorial argument.';

  const { data: concept, error: conceptError } = await db
    .from('concepts')
    .insert({
      channel_id: channelId,
      title,
      angle,
      // Not 'v1' — this concept did not go through the trend rubric and labelling it as
      // though it had would make the scoring history unreadable.
      rubric_version: 'studio-session',
      status: 'in_production',
    })
    .select('id')
    .single();

  if (conceptError || !concept) {
    return {
      ok: false,
      code: 'concept_insert_failed',
      detail: conceptError?.message ?? 'No row returned.',
      remedy: 'Run pnpm db:doctor.',
    };
  }

  // The script is deliberately thin. A Studio session's script is written by the
  // conversation over many turns, so what lands here on first generation is a stub that
  // the session then edits — `human_edit_count` rises per turn that changes direction,
  // which is exactly the provenance the addendum asks for.
  const voText = seed.voText?.trim() || '';
  const beats: Json = [];

  const { data: script, error: scriptError } = await db
    .from('scripts')
    .insert({
      concept_id: concept.id,
      version: 1,
      hook: title,
      beats,
      vo_text: voText,
      // The addendum's value. Not 'claude-opus-5': the model drafted this inside a session
      // with tools and a human arguing back, and that is a different provenance claim from
      // a one-shot stage-3 draft.
      drafted_by: 'studio-agent',
      human_edit_count: 0,
      structure_hash: sessionStructureHash(sessionId),
    })
    .select('id')
    .single();

  if (scriptError || !script) {
    return {
      ok: false,
      code: 'script_insert_failed',
      detail: scriptError?.message ?? 'No row returned.',
      remedy: 'Run pnpm db:doctor.',
    };
  }

  const { error: linkError } = await db
    .from('studio_sessions')
    .update({ script_id: script.id, channel_id: channelId })
    .eq('id', sessionId);

  if (linkError) {
    return {
      ok: false,
      code: 'session_link_failed',
      detail: `The script exists (${script.id}) but the session does not point at it: ${linkError.message}`,
      remedy: 'Re-run; materialisation is keyed on the session pointer and will retry.',
    };
  }

  return { ok: true, scriptId: script.id, conceptId: concept.id, created: true };
}

async function firstActiveChannel(db: Db): Promise<string | null> {
  const { data } = await db
    .from('channels')
    .select('id')
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * A placeholder structure hash, and why it is not the real one.
 *
 * `structureHash()` hashes a drafted script's beat profile, and a freshly materialised
 * Studio script has no beats yet — it acquires them as the session writes them. Hashing an
 * empty beat list would give every Studio script the same hash, which is a collision that
 * means "these videos are built the same way" about videos that do not exist yet, and the
 * publish gate reads exactly that signal.
 *
 * So the stub carries a hash that cannot collide, prefixed so it is obvious in a query
 * that it is not a structural claim. The real hash is computed when the session's beats
 * are written, in the same place the pipeline lane computes it.
 */
function sessionStructureHash(sessionId: string): string {
  return `studio-stub:${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}
