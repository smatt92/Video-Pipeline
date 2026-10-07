import { reelPreflight } from './instagram';

/**
 * The Instagram (Reels) variant of a publish bundle — pure, so the harness drives it exactly.
 *
 * ── Manual posting, on purpose ───────────────────────────────────────────────
 *
 * CLAUDE.md's current phase: no auto-publish until Meta app review clears (decision 0020).
 * So this variant is what Sahil copies into the Instagram app: the same 9:16 MP4, a caption,
 * a cover frame, alt text and a first comment. "Mark posted" with the permalink then records
 * it so metrics can find the Reel once the read permissions are granted.
 *
 * Limits, from Instagram's own documentation as of 2026-10 (verify at submission):
 *   - caption ≤ 2,200 characters; Instagram's own advice is 3–5 relevant hashtags, so this
 *     builds 3–5, never 30;
 *   - Reels published through the API are 3 s – 15 min, 9:16 (`reelPreflight`) — the manual app
 *     allows longer, but a variant that the API path would refuse is flagged, not hidden, so
 *     the day publishing switches on nothing changes shape.
 */

export const CAPTION_MAX = 2200;
export const HASHTAGS_MIN = 3;
export const HASHTAGS_MAX = 5;
export const ALT_TEXT_MAX = 300;

export interface InstagramVariantInput {
  channelName: string;
  seriesName: string;
  title: string;
  premise: string;
  fact: { claim: string; source_url: string } | null;
  /** The channel bible's hashtag pool, without '#'. */
  hashtagPool: readonly string[];
  pinnedComment: string | null;
  /** The render the YouTube bundle carries — the same file is posted as the Reel. */
  render: { width: number; height: number; durationS: number | null };
  /** Seconds into the video for the cover frame. */
  coverFrameS: number;
}

export interface InstagramVariant {
  caption: string;
  hashtags: string[];
  alt_text: string;
  first_comment: string;
  cover_frame_s: number;
  /** Null when the file fits the Reels API limits; else why it would not (still postable by hand). */
  reels_api_problem: string | null;
}

/** "Incident Report" → "IncidentReport"; anything not [A-Za-z0-9_] is dropped. */
export function toHashtag(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function buildInstagramVariant(i: InstagramVariantInput): InstagramVariant {
  // 3–5: the pool first (the channel's own judgement), then the series and channel names, so
  // even a one-tag pool reaches three.
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const raw of [...i.hashtagPool, toHashtag(i.seriesName), toHashtag(i.channelName)]) {
    const t = raw.replace(/^#/, '');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    hashtags.push(t);
    if (hashtags.length === HASHTAGS_MAX) break;
  }
  const tagLine = hashtags.map((t) => `#${t}`).join(' ');

  const tail = [i.fact ? `The real bit: ${i.fact.claim}` : null, i.fact ? `Source: ${i.fact.source_url}` : null, '', tagLine]
    .filter((x) => x !== null)
    .join('\n');
  // The premise is what gets shortened when the whole would exceed the limit: the title, the
  // sourced fact and the hashtags are never cut.
  const fixed = `${i.title}\n\n\n\n${tail}`.length;
  const premise = clip(i.premise, Math.max(0, CAPTION_MAX - fixed));
  const caption = `${i.title}\n\n${premise}\n\n${tail}`;

  const alt = clip(`${i.channelName} — ${i.seriesName}: ${i.title}. ${i.premise}`, ALT_TEXT_MAX);
  const firstComment = [i.pinnedComment, i.fact ? `Source: ${i.fact.source_url}` : null].filter(Boolean).join('\n');

  return {
    caption,
    hashtags,
    alt_text: alt,
    first_comment: firstComment,
    cover_frame_s: Math.max(0, i.render.durationS === null ? i.coverFrameS : Math.min(i.coverFrameS, i.render.durationS)),
    reels_api_problem: reelPreflight(i.render),
  };
}

/**
 * A Reel's shortcode from its permalink: instagram.com/reel/<code>/ or /p/<code>/ (with or
 * without www, query string or trailing slash). Null for anything else — "Mark posted"
 * refuses a link it cannot read rather than storing it.
 */
export function instagramShortcode(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#].*)?$/.exec(url.trim());
  return m ? m[1]! : null;
}
