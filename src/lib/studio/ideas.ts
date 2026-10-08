import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type Anthropic from '@anthropic-ai/sdk';

import type { ChannelBible, Series } from '../bureau/bible';
import { FORMAT_INFO, type MotionLevel, type VisualFormat } from '../bureau/formats';
import type { Db } from '../db/server';
import { routed, RouterError } from '../llm/router';
import { STUDIO_IDEAS_PROMPT_REF, STUDIO_IDEAS_SYSTEM } from '../prompts/24-studio-ideas.v1';
import { signalsForConcepts } from '../trends/relevance';

/**
 * Studio's Ideas button (Sahil, 08-Oct: "an ideas button based on the trend too").
 *
 * Reads the active channel's most relevant trends — highest relevance first, so the top of the
 * distribution (0051's scores; the p95 sits near 0.86 on both channels today) — and asks the
 * cheapest tier for five ideas that fit the channel's own series. Each idea comes back with a
 * ready-to-send session prompt (`ideaPrompt`) that calls draft_brief with fields inside its
 * limits, so picking one fills the Studio box with something that drafts first time.
 *
 * Nothing is drafted or approved here. The one call is ledgered against the channel by the
 * router (rule 5); a refusal says why, and the trends it would have used are still shown.
 */

const TOP_TRENDS = 20;

export const IdeaSchema = z.object({
  series: z.string().min(1).max(40),
  trend: z.string().min(1).max(200),
  topic: z.string().min(3).max(200),
  hook: z.string().min(3).max(200),
  why: z.string().min(3).max(200),
});
const IdeasOutput = z.object({ ideas: z.array(IdeaSchema).min(1).max(5) });

export interface StudioIdea {
  series: string;
  seriesName: string;
  videoType: VisualFormat;
  motion: MotionLevel | null;
  trend: string;
  /** The trend's relevance (0..1); null when the trend the model named is not one it was given. */
  relevance: number | null;
  topic: string;
  hook: string;
  why: string;
  /** The text the Studio box is filled with — a complete first message for the session. */
  prompt: string;
}

export type IdeasResult =
  | { ok: true; ideas: StudioIdea[]; basis: string; costInr: number | null }
  | { ok: false; reason: string; basis: string | null };

export interface IdeasDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  client?: Pick<Anthropic, 'messages'>;
}

/** The session's first message for an idea. Fields match draft_brief's schema and limits. */
export function ideaPrompt(i: { series: string; videoType: VisualFormat; motion: MotionLevel | null; topic: string; hook: string; trend: string }, perShortCapInr: number | null): string {
  const lines = [
    'Draft one brief for this channel. Use draft_brief with exactly:',
    `- video_type: ${i.videoType}`,
    ...(i.videoType === 'engineered' && i.motion ? [`- motion: ${i.motion}`] : []),
    `- series: ${i.series}`,
    `- topic: ${i.topic}`,
    `- hook: ${i.hook}`,
    '',
    'Rules for the script:',
    '- One idea only, built beat by beat; hook in the first 2 seconds.',
    '- No brand names, logos or real people on screen, in titles or in pictures.',
    '- Only state figures you are confident are true; leave out any number you cannot back up.',
    `- Why now: it ties to the trend "${i.trend}" — keep the video useful after the trend passes.`,
    '',
    `Then run price_brief and show me the price of every motion level against the ${perShortCapInr === null ? 'per-Short cap' : `₹${perShortCapInr} per-Short cap`}. Do not approve anything. Give me the Approvals link.`,
  ];
  return lines.join('\n');
}

function seriesBlock(cb: ChannelBible): { text: string; byId: Map<string, Series> } {
  const byId = new Map<string, Series>();
  const parts: string[] = [];
  for (const s of Object.values(cb.series)) {
    if (!s) continue;
    byId.set(s.id, s);
    parts.push(`- id: ${s.id} · ${s.name} · default type ${FORMAT_INFO[s.visual_format ?? 'illustrated'].label}\n  premise types: ${s.premise_types.join('; ')}\n  rules: ${s.rules.slice(0, 4).join('; ')}`);
  }
  return { text: parts.join('\n'), byId };
}

export async function proposeIdeas(
  channel: { id: string; name: string },
  cb: ChannelBible,
  opts: { relevanceThreshold: number; perShortCapInr: number | null },
  deps: IdeasDeps,
): Promise<IdeasResult> {
  const sig = await signalsForConcepts(deps.db, channel.id, TOP_TRENDS, opts.relevanceThreshold);
  const scored = sig.signals.filter((s) => s.relevance !== null);
  if (scored.length === 0) {
    return { ok: false, reason: `No scored trends for ${channel.name} in the last fortnight — run Trends first.`, basis: sig.basis };
  }
  const { text: seriesText, byId } = seriesBlock(cb);
  if (byId.size === 0) return { ok: false, reason: `${channel.name} runs no series yet.`, basis: sig.basis };

  const trendText = scored.map((s) => `- ${s.term} (relevance ${s.relevance!.toFixed(2)}, ${s.source})`).join('\n');
  const user = `Channel: ${channel.name}\n\nSeries:\n${seriesText}\n\nTrends, most relevant first:\n${trendText}\n\nPropose 5 ideas.`;

  let data: z.infer<typeof IdeasOutput>;
  let costInr: number | null;
  try {
    const r = await routed(
      { task: 'studio_ideas', system: STUDIO_IDEAS_SYSTEM, user, schema: IdeasOutput, maxTokens: 2000 },
      {
        db: deps.db,
        apiKey: deps.apiKey,
        usdInrRate: deps.usdInrRate,
        client: deps.client,
        subject: { kind: 'channel', channelId: channel.id, idempotencyKey: `studio-ideas:${randomUUID()}:${STUDIO_IDEAS_PROMPT_REF}`, stage: '02-concept' },
      },
    );
    data = r.data;
    costInr = r.costInr;
  } catch (err) {
    const why = err instanceof RouterError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Ideas could not be written — ${why.slice(0, 300)}`, basis: sig.basis };
  }

  const relevanceOf = new Map(scored.map((s) => [s.term.toLowerCase(), s.relevance!]));
  const ideas: StudioIdea[] = [];
  for (const i of data.ideas) {
    const series = byId.get(i.series);
    if (!series) continue; // a series this channel does not run: dropped, never guessed
    const videoType: VisualFormat = series.visual_format ?? 'illustrated';
    const motion: MotionLevel | null = videoType === 'engineered' ? (series.motion ?? 'key') : null;
    const base = { series: series.id, videoType, motion, topic: i.topic, hook: i.hook, trend: i.trend };
    ideas.push({
      ...base,
      seriesName: series.name,
      relevance: relevanceOf.get(i.trend.toLowerCase()) ?? null,
      why: i.why,
      prompt: ideaPrompt(base, opts.perShortCapInr),
    });
  }
  if (ideas.length === 0) return { ok: false, reason: 'The ideas named no series this channel runs, so none were kept.', basis: sig.basis };
  return { ok: true, ideas, basis: `top ${scored.length} trends by relevance (${scored[0].relevance!.toFixed(2)} to ${scored[scored.length - 1].relevance!.toFixed(2)})`, costInr };
}
