import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { bibleForChannel } from './bible';
import { characterMentions, complaintScore, isQuestion } from './comments';

/**
 * The Bureau's read-back loop: metric snapshots at 1h / 24h / 72h / 7d after the slot, and
 * comment ingestion with character-name mentions and Complaint Box scores.
 *
 * The vendor calls are injected (src/lib/publish/yt-analytics.ts in production), so this is
 * the logic only and a harness can drive every branch. A pull that fails writes an
 * `unavailable` snapshot with the reason — a row you can select — never a row of zeros.
 */

export const BUCKETS: { bucket: '1h' | '24h' | '72h' | '7d'; hours: number }[] = [
  { bucket: '1h', hours: 1 },
  { bucket: '24h', hours: 24 },
  { bucket: '72h', hours: 72 },
  { bucket: '7d', hours: 168 },
];

/** Buckets whose age has been reached and which have no snapshot yet. Pure. */
export function dueBuckets(base: Date, now: Date, captured: readonly string[]): ('1h' | '24h' | '72h' | '7d')[] {
  const ageH = (now.getTime() - base.getTime()) / 3_600_000;
  return BUCKETS.filter((b) => ageH >= b.hours && !captured.includes(b.bucket)).map((b) => b.bucket);
}

export interface MetricsDeps {
  db: Db;
  now?: () => Date;
  analytics(videoId: string, startDate: string, endDate: string): Promise<
    | { ok: true; metrics: { views: number | null; engagedViews: number | null; averageViewPercentage: number | null; subscribersGained: number | null }; raw: unknown }
    | { ok: false; code: string; detail: string }
  >;
  comments?(videoId: string): Promise<
    | { ok: true; comments: { externalId: string; author: string | null; body: string; likes: number | null; replies: number | null; publishedAt: string | null; isPublic: boolean }[] }
    | { ok: false; code: string; detail: string }
  >;
}

export async function pullBureauMetrics(deps: MetricsDeps) {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { data: pubs } = await db
    .from('publications')
    .select('id, channel_id, episode_id, external_post_id, scheduled_for, published_at, status, platform')
    .not('episode_id', 'is', null)
    .not('external_post_id', 'is', null)
    .in('status', ['scheduled', 'live'])
    .eq('platform', 'youtube');

  let snapshots = 0;
  let unavailable = 0;
  let commentsIn = 0;
  for (const p of pubs ?? []) {
    const baseIso = p.published_at ?? p.scheduled_for;
    if (!baseIso) continue;
    const base = new Date(baseIso);
    if (base > now) continue;
    if (p.status === 'scheduled') {
      // Past its slot: YouTube made it public at publishAt (or Sahil did in Studio).
      await db.from('publications').update({ status: 'live', published_at: base.toISOString() }).eq('id', p.id);
      await db.from('episodes').update({ status: 'live' }).eq('id', p.episode_id!);
    }

    const { data: have } = await db.from('metrics_snapshots').select('age_bucket').eq('publication_id', p.id);
    for (const bucket of dueBuckets(base, now, (have ?? []).map((h) => h.age_bucket))) {
      const r = await deps.analytics(p.external_post_id!, base.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
      if (r.ok && r.metrics.views !== null) {
        await db.from('metrics_snapshots').insert({
          publication_id: p.id,
          age_bucket: bucket,
          views: r.metrics.views,
          engaged_views: r.metrics.engagedViews,
          engaged_views_source: r.metrics.engagedViews === null ? null : 'analytics:engagedViews',
          avg_view_pct: r.metrics.averageViewPercentage,
          subs_gained: r.metrics.subscribersGained,
          metric_source: 'vendor_api',
          status: 'measured',
          raw: r.raw as Json,
        });
        snapshots++;
      } else {
        await db.from('metrics_snapshots').insert({
          publication_id: p.id,
          age_bucket: bucket,
          metric_source: 'vendor_api',
          status: 'unavailable',
          unavailable_reason: r.ok ? 'the report returned no views for this video yet' : `${r.code}: ${r.detail}`.slice(0, 500),
        });
        unavailable++;
      }
    }

    // Comments for the first 30 days, every run; upsert keeps it idempotent.
    if (deps.comments && now.getTime() - base.getTime() < 30 * 86_400_000) {
      const c = await deps.comments(p.external_post_id!);
      if (c.ok && c.comments.length) {
        // The publication's channel's cast — a mention of Pip is a Bureau mention only.
        const cast = await bibleForChannel(db, p.channel_id).catch(() => null);
        const rows = c.comments.map((x) => ({
          channel_id: p.channel_id,
          publication_id: p.id,
          platform: 'youtube',
          external_id: x.externalId,
          author_handle: x.author,
          is_public: x.isPublic,
          body: x.body,
          like_count: x.likes,
          reply_count: x.replies,
          published_at: x.publishedAt,
          character_mentions: cast ? characterMentions(x.body, cast) : [],
          is_question: isQuestion(x.body),
          complaint_score: complaintScore({ body: x.body, is_public: x.isPublic, like_count: x.likes }),
        }));
        const { error } = await db.from('comments').upsert(rows, { onConflict: 'platform,external_id' });
        if (!error) commentsIn += rows.length;
      }
    }
  }
  return { publications: (pubs ?? []).length, snapshots, unavailable, comments: commentsIn };
}
