import { BIBLE } from './bible';

/**
 * Comment mining, the deterministic half: which characters a comment names, whether it is
 * a question, and how good a Complaint Box candidate it is. The Sunday series is built from
 * real comments, so a candidate must be public, specific and answerable — the score ranks
 * them; Routine C picks.
 */

const NAME_PATTERNS: { slug: string; re: RegExp }[] = BIBLE.characters.map((c) => {
  const names = new Set([c.name, c.name.replace(/\./g, ''), c.id.replace(/_/g, ' ')]);
  const last = c.name.split(/\s+/).pop();
  // Single-word surnames only when distinctive: "Box" alone is not Complaint Box.
  if (last && last.length > 3 && !['box', 'auditor'].includes(last.toLowerCase())) names.add(last);
  const alt = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  return { slug: c.id, re: new RegExp(`(^|[^\\p{L}])(${alt})(?=$|[^\\p{L}])`, 'iu') };
});

export function characterMentions(body: string): string[] {
  return NAME_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.slug);
}

export function isQuestion(body: string): boolean {
  return /\?\s*$|\?\s|^(why|how|what|when|where|who|is|are|can|does|do)\b/i.test(body.trim());
}

const COMPLAINT = /\b(why (does|is|do|can't|cant|won't)|who (decided|approved)|i (want|demand) (a|to)|complain|unfair|broken|stupid|annoying|ridiculous|refund|file a|make it stop|fix (it|this))\b/i;

/**
 * 0–1. Higher for a public, specific, physics-or-history-shaped complaint; zero for a
 * private comment (it can never be credited) and for anything shorter than a sentence.
 */
export function complaintScore(c: { body: string; is_public: boolean; like_count: number | null }): number {
  if (!c.is_public) return 0;
  const body = c.body.trim();
  if (body.length < 20) return 0;
  let s = 0;
  if (COMPLAINT.test(body)) s += 0.45;
  if (isQuestion(body)) s += 0.2;
  if (/\b(gravity|moon|sun|time|calendar|leap|tide|ocean|space|myth|history|why does|physics|clock|year)\b/i.test(body)) s += 0.2;
  s += Math.min(0.15, Math.log10(1 + (c.like_count ?? 0)) / 20);
  return Math.round(Math.min(1, s) * 100) / 100;
}
