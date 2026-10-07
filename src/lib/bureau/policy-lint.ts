import { z } from 'zod';

import type { ChannelBible } from './bible';
import { graphicsOf } from './graphics';
import { graphicsText, isEngineeredShotList, unhedgedNumbers } from './hedge';

/**
 * policy_lint — the deterministic half of the channel's content policy.
 *
 * Rules come from the channel's `channels/<slug>/policy.json`; this file only applies them.
 * Three outcomes, and they are not two:
 *
 *   pass         every deterministic rule held and nothing needed judgement
 *   fail         a rule was broken; `violations` names each one with the text that broke it
 *   needs_judge  nothing was broken that a pattern can see, but something a pattern cannot
 *                decide is present (an unknown proper name, a religious claim) — the judge
 *                model, then Sahil, decides. Never reported as a pass.
 *
 * The judge is a dependency, not a call made from here, so this module stays pure and the
 * harness drives every branch without spending anything.
 */

export const FactSchema = z.object({
  claim: z.string().min(10),
  source_url: z.url().refine((u) => /^https:\/\//.test(u), 'source_url must be https'),
  source_title: z.string().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const LintInputSchema = z.object({
  series: z.string().optional(),
  premise: z.string().optional(),
  script_text: z.string().min(1),
  punchlines: z.array(z.string()).optional(),
  titles: z.array(z.union([z.string(), z.object({ text: z.string(), hook_archetype: z.string() })])).optional(),
  pinned_comment: z.string().optional(),
  music_bed: z.string().optional(),
  shot_list: z.array(z.record(z.string(), z.unknown())).optional(),
  /** A single fact object, or an array (which must then have length exactly 1). */
  fact: z.unknown().optional(),
  facts: z.array(z.unknown()).optional(),
});
export type LintInput = z.infer<typeof LintInputSchema>;

export interface Violation {
  rule: string;
  detail: string;
  match?: string;
}

export interface LintResult {
  status: 'pass' | 'fail' | 'needs_judge';
  violations: Violation[];
  judge_questions: string[];
  fact: { ok: boolean; source_class: SourceClass | null; domain: string | null };
  word_count: number;
  policy_version: number;
}

export type SourceClass =
  | 'gov'
  | 'edu'
  | 'space_agency'
  | 'met_ocean_agency'
  | 'museum'
  | 'peer_reviewed'
  | 'standards_body'
  | 'other';

const SPACE = /(^|\.)(nasa\.gov|esa\.int|isro\.gov\.in|jaxa\.jp|jpl\.nasa\.gov)$/;
const MET_OCEAN = /(^|\.)(noaa\.gov|metoffice\.gov\.uk|imd\.gov\.in|ecmwf\.int|wmo\.int|bom\.gov\.au)$/;
const MUSEUM = /(^|\.)(si\.edu|britishmuseum\.org|nhm\.ac\.uk|metmuseum\.org|amnh\.org|sciencemuseum\.org\.uk|vam\.ac\.uk)$|museum/;
const PEER = /(^|\.)(doi\.org|nature\.com|science\.org|pnas\.org|ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|arxiv\.org|cell\.com|thelancet\.com|royalsocietypublishing\.org|agupubs\.onlinelibrary\.wiley\.com|iopscience\.iop\.org|aanda\.org)$/;
const STANDARDS = /(^|\.)(iso\.org|nist\.gov|bipm\.org|iers\.org|ietf\.org|ieee\.org|itu\.int)$/;

/** Most specific class first: nasa.gov is a space agency before it is a .gov. */
export function classifySource(url: string): { domain: string | null; source_class: SourceClass } {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { domain: null, source_class: 'other' };
  }
  if (SPACE.test(host)) return { domain: host, source_class: 'space_agency' };
  if (MET_OCEAN.test(host)) return { domain: host, source_class: 'met_ocean_agency' };
  if (STANDARDS.test(host)) return { domain: host, source_class: 'standards_body' };
  if (PEER.test(host)) return { domain: host, source_class: 'peer_reviewed' };
  if (MUSEUM.test(host)) return { domain: host, source_class: 'museum' };
  if (/\.gov(\.[a-z]{2})?$|\.gov$|\.gc\.ca$|\.gouv\.fr$|\.nic\.in$/.test(host)) return { domain: host, source_class: 'gov' };
  if (/\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$/.test(host)) return { domain: host, source_class: 'edu' };
  return { domain: host, source_class: 'other' };
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** The cast's names, lower-cased, as single words and whole — never a judge question. */
export function castNames(cb: Pick<ChannelBible, 'bible'>): ReadonlySet<string> {
  return new Set(cb.bible.characters.flatMap((c) => [c.name, ...c.name.split(/\s+/)]).map((n) => n.replace(/\.$/, '').toLowerCase()));
}

/**
 * Candidate proper names a pattern cannot rule on: two or more capitalised words in a row
 * that are not the cast. "Mrs. Iyer" is cast; "Isaac Newton" is a historical figure the
 * judge should allow; "Ravi Kumar" might be a living person. The lint does not guess which.
 */
/** Capitalised words that are never part of a person's name in this show's writing. */
const NOT_NAMES = new Set(
  ('the a an this that our your my his her their of and or in on at to for from by with ' +
    'moon sun earth mars venus jupiter saturn mercury space ocean sea monday tuesday wednesday ' +
    'thursday friday saturday sunday january february march april may june july august september ' +
    'october november december bureau reality department desk office director auditor archive ' +
    'myth myths gravity time calendar calendars complaint complaints box lost property form memo ' +
    'files file incident report tour deep first year season episode intern pool lantern chemistry ' +
    'optics biology weather orbit').split(/\s+/),
);
const looksLikeLabel = (w: string) => /(ly|able|ible|ment|ness|tion|ity)$/i.test(w);

export function properNameCandidates(text: string, cast: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  // Quoted text is a label, a stamp or a form title in this show — never a person.
  const unquoted = text.replace(/["“][^"”]*["”]/g, ' ');
  const re = /\b([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+)\b/g;
  for (const m of unquoted.matchAll(re)) {
    const words = m[1].split(/\s+/);
    const unknown = words.filter((w) => {
      const k = w.toLowerCase().replace(/[.'’]s?$/, '');
      return !cast.has(k) && !NOT_NAMES.has(k) && !looksLikeLabel(w);
    });
    // A sentence-initial capital plus one cast name is not a name ("Today Marlo …").
    if (unknown.length >= 2) found.add(m[1]);
  }
  return [...found];
}

function textOf(input: LintInput): string {
  const titles = (input.titles ?? []).map((t) => (typeof t === 'string' ? t : t.text));
  return [input.premise, input.script_text, ...(input.punchlines ?? []), ...titles, input.pinned_comment]
    .filter(Boolean)
    .join('\n');
}

export function policyLint(raw: unknown, cb: Pick<ChannelBible, 'bible' | 'policy'>): LintResult {
  const policy = cb.policy;
  const input = LintInputSchema.parse(raw);
  const violations: Violation[] = [];
  const judge: string[] = [];
  const text = textOf(input);
  const isLong = input.series === 'long_form';

  // ── Reject categories ────────────────────────────────────────────────────
  for (const cat of policy.reject_categories) {
    for (const pattern of cat.patterns) {
      const m = new RegExp(pattern, 'i').exec(text);
      if (m) {
        violations.push({ rule: cat.id, detail: cat.why, match: m[0] });
        break;
      }
    }
    // Styling fields: the kid-coded check reads the music bed and shot styles too, because a
    // nursery palette is a styling decision that never appears in the script.
    if (cat.styling_fields?.length) {
      const styling = [
        input.music_bed ?? '',
        ...(input.shot_list ?? []).map((s) => String(s.style ?? '')),
      ].join('\n');
      for (const pattern of cat.patterns) {
        const m = new RegExp(pattern, 'i').exec(styling);
        if (m && !violations.some((v) => v.rule === cat.id)) {
          violations.push({ rule: cat.id, detail: `${cat.why} (styling)`, match: m[0] });
        }
      }
    }
  }

  // ── Myth Desk: interpretations must be labelled ──────────────────────────
  if (input.series === 'myth') {
    const labelled = policy.myth_interpretation_markers.some((mk) => text.toLowerCase().includes(mk));
    if (!labelled) {
      violations.push({
        rule: 'myth_unlabelled',
        detail: `Myth Desk scripts label interpretations (${policy.myth_interpretation_markers.join(', ')}).`,
      });
    }
  }

  // ── Exactly one sourced fact ─────────────────────────────────────────────
  const factList = input.facts ?? (input.fact === undefined ? [] : Array.isArray(input.fact) ? input.fact : [input.fact]);
  let factOk = false;
  let sourceClass: SourceClass | null = null;
  let domain: string | null = null;
  if (factList.length !== policy.required.sourced_facts_exactly) {
    violations.push({
      rule: 'fact_count',
      detail: `Exactly ${policy.required.sourced_facts_exactly} sourced fact is required; got ${factList.length}.`,
    });
  } else {
    const parsed = FactSchema.safeParse(factList[0]);
    if (!parsed.success) {
      violations.push({
        rule: 'fact_shape',
        detail: parsed.error.issues.map((i) => `${i.path.join('.') || 'fact'}: ${i.message}`).join('; '),
      });
    } else {
      const c = classifySource(parsed.data.source_url);
      sourceClass = c.source_class;
      domain = c.domain;
      if (!policy.required.fact_source_classes.includes(c.source_class)) {
        violations.push({
          rule: 'fact_source_class',
          detail:
            `The source (${c.domain ?? 'unparseable'}) is not a primary source class ` +
            `(${policy.required.fact_source_classes.join(', ')}).`,
        });
      } else {
        factOk = true;
      }
    }
  }

  // ── Shape ────────────────────────────────────────────────────────────────
  const words = wordCount(input.script_text);
  const maxWords = isLong ? 2000 : policy.required.script_max_words;
  if (words > maxWords) {
    violations.push({ rule: 'script_length', detail: `${words} words; the limit is ${maxWords}.` });
  }
  if (input.punchlines && input.punchlines.length !== policy.required.punchlines) {
    violations.push({ rule: 'punchlines', detail: `${input.punchlines.length} punchlines; exactly ${policy.required.punchlines} required.` });
  }
  if (input.titles) {
    if (input.titles.length !== policy.required.titles) {
      violations.push({ rule: 'titles', detail: `${input.titles.length} titles; exactly ${policy.required.titles} required.` });
    }
    if (policy.required.titles_distinct_hook_archetypes) {
      const archetypes = input.titles.map((t) => (typeof t === 'string' ? null : t.hook_archetype));
      if (archetypes.some((a) => a === null)) {
        violations.push({ rule: 'title_archetypes', detail: 'Each title must name its hook archetype.' });
      } else if (new Set(archetypes).size !== archetypes.length) {
        violations.push({ rule: 'title_archetypes', detail: 'The three titles must use three different hook archetypes.' });
      }
    }
  }

  // ── Engineered (0052): every number sourced or hedged ────────────────────
  // A 3D explainer states physical figures out loud and on meters. A figure that is not the
  // sourced fact's own must carry "≈"/"about"/…, or it is a precise claim nobody checked.
  // Applied only to engineered briefs, so no other format's scripts change outcome.
  if (isEngineeredShotList(input.shot_list)) {
    const sourced = factList.map((f) => (f && typeof f === 'object' ? String((f as { claim?: unknown }).claim ?? '') : ''));
    const read = [input.script_text, ...(input.shot_list ?? []).map((s) => graphicsText(graphicsOf(s.graphics)))].join('\n');
    const bare = unhedgedNumbers(read, sourced);
    if (bare.length) {
      violations.push({
        rule: 'unhedged_number',
        detail: `Numbers must be the sourced fact's own or hedged ("≈", "about", "roughly"): ${bare.join(', ')}.`,
        match: bare[0],
      });
    }
  }

  // ── What a pattern cannot decide ─────────────────────────────────────────
  for (const name of properNameCandidates(text, castNames(cb))) {
    judge.push(`Is "${name}" a real living person? (Historical figures are allowed only as part of the sourced fact.)`);
  }
  if (/\b(god|goddess|deity|divine|sacred|holy)\b/i.test(text)) {
    judge.push('Does any line assert a religious claim as true rather than report what a tradition says?');
  }

  const status = violations.length ? 'fail' : judge.length ? 'needs_judge' : 'pass';
  return {
    status,
    violations,
    judge_questions: judge,
    fact: { ok: factOk, source_class: sourceClass, domain },
    word_count: words,
    policy_version: policy.version,
  };
}
