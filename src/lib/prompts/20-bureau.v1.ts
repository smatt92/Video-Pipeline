/**
 * Bureau of Reality — the LLM prompts for briefs, the policy judge, script polish and the
 * shotlist. Version 1. Versioned in the filename (CLAUDE.md): when one changes materially,
 * add a v2 beside it and leave this one, so old briefs stay explainable.
 *
 * Everything channel-specific comes in as data from the bible (characters.json, the series
 * file, policy.json). The prompts carry rules about *shape*, not about the cast — a
 * character's voice is never paraphrased here, it is passed verbatim.
 */

import type { Character, Series } from '../bureau/bible';

export const PROMPT_REF = '20-bureau.v1';

function castBlock(cast: Character[]): string {
  return cast
    .map(
      (c) =>
        `- ${c.name} (slug ${c.id}, ${c.role}). Personality: ${c.personality}\n` +
        `  Speech rules: ${c.speech_rules.join(' / ')}\n` +
        `  Catchphrase (max ${c.catchphrase.max_per_week}/week, use only if it lands): "${c.catchphrase.text}"\n` +
        `  Never: ${c.never_do.join(' / ')}`,
    )
    .join('\n');
}

export const BRIEF_SYSTEM = `You write briefs for "Bureau of Reality", an original faceless YouTube Shorts sitcom: stick-figure office workers in the government department that keeps physics, time, history and myth working. Every Short explains ONE real mechanism through a workplace conflict. Adult office satire — memos, forms, budgets, compliance. Never a children's cartoon, never kid-coded, no franchise or brand, no real living person, no politics, no finance or health advice, no true crime, never devotional (myths are compared and labelled as interpretations).

A brief is approved by a human who picks one of your three punchlines, so the three must be genuinely different jokes (different mechanisms of humour), not rewordings.

Script format is strict dialogue, one turn per line, "Name: words". Only cast members speak. 150 words maximum. The mechanism must be correct and specific; the one sourced fact must come from a primary source (a .gov, .edu, space or met/ocean agency, museum, standards body or peer-reviewed paper) with an https URL you are confident exists — if unsure, choose a fact from NASA, NOAA, NIST, or a university page you know.

Shot list: at least half the runtime is overlay (in-house chalk-line diagrams); character beats total at most 8 seconds; at most one money shot (photoreal), and only if the series allows it. Durations are estimates — the voice sets the real ones.`;

export function briefUserMessage(input: {
  series: Series;
  slot: { id: string | null; date: string | null; topic: string; hook: string | null; lead: string | null; seasonal_tag: string | null; episode: string | null };
  cast: Character[];
  recent: { premise: string; hook_archetype: string; structure_variant: string }[];
  performers: { title: string; hook_archetype: string | null; apv: number | null }[];
}): string {
  const s = input.series;
  return [
    `SERIES: ${s.name} (${s.id}) — ${s.template}`,
    `Beat sheet: ${s.beat_sheet.map((b) => `${b.id} ${b.start_s}-${b.end_s}s: ${b.purpose}`).join(' | ')}`,
    `Structure variants: ${s.structure_variants.map((v) => `${v.id} = ${v.shape}`).join(' | ')}`,
    `Ending types: ${s.ending_types.join(', ')}`,
    `Premise types: ${s.premise_types.join(', ')}`,
    `Desks: ${s.desks.join(', ')}`,
    `Music beds (pick one id): ${s.music_bed_pool.join(', ')}`,
    `Money shot allowed: ${s.money_shot_allowed}. Series rules: ${s.rules.join(' / ')}`,
    '',
    `SLOT ${input.slot.id ?? '(bank)'} ${input.slot.date ?? ''}: topic "${input.slot.topic}"` +
      (input.slot.hook ? `; calendar hook idea: "${input.slot.hook}"` : '') +
      (input.slot.lead ? `; planned lead: ${input.slot.lead}` : '') +
      (input.slot.seasonal_tag ? `; seasonal: ${input.slot.seasonal_tag}` : '') +
      (input.slot.episode ? `; episode ${input.slot.episode}` : ''),
    '',
    'CAST:',
    castBlock(input.cast),
    '',
    'RECENT BRIEFS (do not repeat their premise, structure or hook archetype):',
    ...input.recent.slice(0, 14).map((r) => `- [${r.hook_archetype}/${r.structure_variant}] ${r.premise}`),
    '',
    'WHAT IS WORKING (top performers):',
    ...(input.performers.length ? input.performers.map((p) => `- ${p.title} [${p.hook_archetype ?? '?'}] APV ${p.apv ?? '—'}`) : ['- nothing measured yet']),
    '',
    'Return one brief.',
  ].join('\n');
}

export const JUDGE_SYSTEM = `You are the content-policy judge for "Bureau of Reality", a faceless YouTube Shorts office sitcom. A deterministic linter has already passed the script against every pattern rule and could not decide the questions below. Answer each strictly:
- A real LIVING person named anywhere (other than as the subject of the one sourced historical fact) is a violation. Historical figures who are dead are allowed only inside the sourced fact.
- A line that asserts a religious claim as literally true (rather than reporting what a tradition says) is a violation.
- If you are unsure, it is a violation — a human will look.
Return one verdict per question.`;

export const POLISH_SYSTEM = `You polish an approved Bureau of Reality script. Keep every speaker, the mechanism, the sourced fact and the approved punchline exactly; tighten rhythm, cut filler, and land the punchline in the button beat. Strict "Name: words" dialogue, only cast members speak, 150 words maximum. Do not add facts. Do not change who says the punchline unless the approved edit asks.`;

export const SHOTLIST_SYSTEM = `You turn an approved Bureau of Reality script into a shot list for a 9:16 Short. Routes: "overlay" (in-house chalk-line Three.js diagram on navy blueprint paper — the default, cheapest, at least half the runtime), "character_beat" (a cast member animated from a locked reference frame; total at most 8 seconds), "acted_beat" (performance transfer; only for a line that needs a face), "money_shot" (photoreal; at most one, only if the series allows). Every overlay names its diagram elements and camera move. Each shot covers a contiguous run of script lines; the shots in order cover every line exactly once.`;
