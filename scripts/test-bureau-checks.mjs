#!/usr/bin/env node
/**
 * test:bureau — the Bureau's pure rules, no database: policy_lint, the source classifier,
 * variation_check, shot-list cap fitting, script parsing, comment mining and the router's
 * task table. Every expected value below is written out by hand from the rule's text in the
 * prompt or policy.json, never computed by calling the code under test a second time.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { policyLint, classifySource, properNameCandidates } = require(`${B}/bureau/policy-lint.js`);
const { checkVariation, isoWeek } = require(`${B}/bureau/variation.js`);
const { fitToCap } = require(`${B}/bureau/estimate.js`);
const { parseScript, speakerSlug } = require(`${B}/bureau/script-lines.js`);
const { characterMentions, complaintScore } = require(`${B}/bureau/comments.js`);
const { modelFor, TASK_TIER } = require(`${B}/llm/router.js`);
const { voiceRouteFor } = require(`${B}/drivers/voice-route.js`);
const { resolvePunchline } = require(`${B}/bureau/briefs.js`);
const { validateSegments } = require(`${B}/bureau/longform.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};
const fact = { claim: 'The Moon raises the ocean tides on Earth.', source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html' };

console.log('\npolicy_lint\n');
const cases = [
  ['finance_advice', 'Pip: Buy the dip, invest in crypto now.'],
  ['health_advice', 'Marlo: This supplement is a cure for tiredness.'],
  ['politics', 'Iyer: Vote for whoever fixes the calendar in the election.'],
  ['real_living_people', 'Pip: Taylor Swift filed a complaint.'],
  ['franchise_or_brand', 'Pip: It is like Star Wars but with forms.'],
  ['true_crime', 'Nib: The archive holds a cold case about a murder.'],
  ['devotional_framing', 'Kaz: Pray to the lantern and it will answer.'],
  ['kid_coded', 'Pip: Gather round, kids, it is bedtime story time.'],
];
for (const [rule, script] of cases) {
  const r = policyLint({ script_text: script, fact });
  check(r.status === 'fail' && r.violations.map((v) => v.rule).join() === rule, `${rule} is caught and nothing else is`, JSON.stringify(r.violations));
}
const clean = policyLint({ series: 'incident', script_text: 'Pip: Where is the Moon?\nMarlo: Gone. Tides shrink by Friday.', fact });
check(clean.status === 'pass' && clean.fact.source_class === 'met_ocean_agency', 'a clean script with a NOAA fact passes', JSON.stringify(clean));
check(policyLint({ script_text: 'Pip: hi there all.', facts: [fact, fact] }).violations.some((v) => v.rule === 'fact_count'), 'two facts fail "exactly one"');
check(policyLint({ script_text: 'Pip: hi there all.', fact: { ...fact, source_url: 'https://someblog.example.com/moon' } }).violations.some((v) => v.rule === 'fact_source_class'), 'a blog source fails the primary-source rule');
check(policyLint({ series: 'myth', script_text: 'Kaz: The serpent swallows the sun.', fact: { ...fact, source_url: 'https://www.britishmuseum.org/x' } }).violations.some((v) => v.rule === 'myth_unlabelled'), 'a Myth Desk script without an interpretation marker fails');
check(policyLint({ series: 'myth', script_text: 'Kaz: Tradition holds the serpent swallows the sun.', fact: { ...fact, source_url: 'https://www.britishmuseum.org/x' } }).status === 'pass', 'with "tradition holds" it passes');
check(policyLint({ script_text: 'Pip: ' + 'word '.repeat(151), fact }).violations.some((v) => v.rule === 'script_length'), '151 words fails the 150-word limit');
check(policyLint({ script_text: 'Pip: ' + 'word '.repeat(149), fact }).violations.length === 0, '150 words passes');
check(policyLint({ script_text: 'Pip: hi there all.', fact, music_bed: 'nursery rhyme for little ones' }).violations.some((v) => v.rule === 'kid_coded'), 'kid-coded styling in the music bed is caught');
const titles = [{ text: 'a b c', hook_archetype: 'question' }, { text: 'd e f', hook_archetype: 'question' }, { text: 'g h i', hook_archetype: 'warning' }];
check(policyLint({ script_text: 'Pip: hi.', fact, titles }).violations.some((v) => v.rule === 'title_archetypes'), 'two titles with one archetype fail');
const judge = policyLint({ script_text: 'Pip: Ravi Kumar from accounts called.', fact });
check(judge.status === 'needs_judge' && judge.judge_questions.length === 1, 'an unknown two-word name goes to the judge, not a pass', JSON.stringify(judge));
check(properNameCandidates('Marlo stamped "Gravitationally Unavailable" in Lost Property.').length === 0, 'stamps, labels and office nouns are not names');
check(properNameCandidates('Mrs. Iyer and Director Ohm met.').length === 0, 'the cast is not a judge question');

console.log('\nsource classes\n');
for (const [url, cls] of [
  ['https://www.nasa.gov/x', 'space_agency'], ['https://science.nasa.gov/x', 'space_agency'], ['https://www.noaa.gov/x', 'met_ocean_agency'],
  ['https://www.nist.gov/x', 'standards_body'], ['https://doi.org/10.1/x', 'peer_reviewed'], ['https://www.si.edu/x', 'museum'],
  ['https://www.usgs.gov/x', 'gov'], ['https://physics.mit.edu/x', 'edu'], ['https://www.ox.ac.uk/x', 'edu'], ['https://medium.com/x', 'other'],
]) check(classifySource(url).source_class === cls, `${new URL(url).hostname} → ${cls}`, classifySource(url).source_class);

console.log('\nvariation_check\n');
const policy = { variation_window: 14, variation_min_axes: 4, similarity_max: 0.85, hook_archetype_weekly_max: 2, catchphrase_weekly_max: 1 };
const base = { series: 'incident', lead: 'pip', desk: 'gravity', premise_type: 'what_if_removed', structure_variant: 'ladder_hourly', ending_type: 'callback_gag', music_bed: 'bed_typewriter_shuffle', hook_archetype: 'story_open', catchphrase_used: null };
const row = (id, date, over = {}) => ({ brief_id: id, on_date: date, ...base, ...over });
const sim = { checked: true, max: 0.4, nearest_brief_id: null, compared: 3 };
check(isoWeek('2026-10-19') === '2026-W43' && isoWeek('2026-10-25') === '2026-W43' && isoWeek('2026-10-26') === '2026-W44', 'ISO weeks run Monday to Sunday');
const threeSame = checkVariation({ ...base, on_date: '2026-10-21', series: 'desk_tour', lead: 'marlo', desk: 'optics' }, [row('a', '2026-10-19')], policy, sim);
check(threeSame.status === 'fail' && threeSame.failing_axes[0].differing === 3, 'differing on 3 of 7 axes fails (needs 4)', JSON.stringify(threeSame.failing_axes));
const fourDiff = checkVariation({ ...base, on_date: '2026-10-21', series: 'desk_tour', lead: 'marlo', desk: 'optics', music_bed: 'bed_deep_sonar', hook_archetype: 'question' }, [row('a', '2026-10-19')], policy, sim);
check(fourDiff.status === 'pass', 'differing on 4 of 7 passes', JSON.stringify(fourDiff));
const hooks = checkVariation({ ...base, series: 'myth', lead: 'kaz', desk: 'myth', premise_type: 'x', structure_variant: 'y', on_date: '2026-10-22' },
  [row('a', '2026-10-19', { series: 'deep', lead: 'marlo', desk: 'a', premise_type: 'b', structure_variant: 'c' }), row('b', '2026-10-20', { series: 'archive', lead: 'nib', desk: 'd', premise_type: 'e', structure_variant: 'f' })], policy, sim);
check(hooks.status === 'fail' && hooks.hook_archetype.count_including_this === 3 && !hooks.hook_archetype.ok, 'a third story_open in one week fails the 2/week cap');
const nextWeek = checkVariation({ ...base, series: 'myth', lead: 'kaz', desk: 'myth', premise_type: 'x', structure_variant: 'y', on_date: '2026-10-26' },
  [row('a', '2026-10-19', { series: 'deep', lead: 'marlo', desk: 'a', premise_type: 'b', structure_variant: 'c' }), row('b', '2026-10-20', { series: 'archive', lead: 'nib', desk: 'd', premise_type: 'e', structure_variant: 'f' })], policy, sim);
check(nextWeek.hook_archetype.ok && nextWeek.hook_archetype.count_including_this === 1, 'the following Monday starts a new week');
const phrase = checkVariation({ ...fourDiff, ...base, series: 'myth', lead: 'kaz', desk: 'myth', premise_type: 'x', structure_variant: 'y', hook_archetype: 'warning', catchphrase_used: 'I read the manual. Most of it.', on_date: '2026-10-21' },
  [row('a', '2026-10-19', { series: 'deep', lead: 'marlo', desk: 'a', premise_type: 'b', structure_variant: 'c', catchphrase_used: 'I read the manual. Most of it.' })], policy, sim);
check(!phrase.catchphrase.ok && phrase.status === 'fail', "Pip's catchphrase twice in a week fails");
const tooSimilar = checkVariation({ ...base, series: 'myth', lead: 'kaz', desk: 'myth', premise_type: 'x', structure_variant: 'y', hook_archetype: 'warning' }, [], policy, { checked: true, max: 0.85, nearest_brief_id: 'z', compared: 1 });
check(tooSimilar.status === 'fail' && tooSimilar.similarity.ok === false, 'cosine 0.85 fails (must be < 0.85)');
const incomplete = checkVariation({ ...base }, [], policy, { checked: false, reason: 'no key' });
check(incomplete.status === 'incomplete' && incomplete.passed === false, 'no similarity → incomplete, never passed');
const emptyHistory = checkVariation({ ...base }, [], policy, { checked: true, max: null, nearest_brief_id: null, compared: 0 });
check(emptyHistory.status === 'pass' && emptyHistory.similarity.max === null, 'nothing to compare → pass with max null, not 0');
const window = Array.from({ length: 20 }, (_, i) => row(`r${i}`, `2026-09-${String(i + 1).padStart(2, '0')}`, i < 6 ? {} : { series: 'deep', lead: 'marlo', desk: 'a', premise_type: 'b', structure_variant: 'c', hook_archetype: 'warning' }));
const windowed = checkVariation({ ...base, hook_archetype: 'question', on_date: '2026-10-21' }, window, policy, sim);
check(windowed.compared_against === 14 && windowed.status === 'pass', 'only the last 14 by air date are compared (the 6 clones are older)', `${windowed.compared_against} ${windowed.status}`);

console.log('\nfitToCap\n');
const shot = (route, d) => ({ route, description: 'x x x', duration_s: d, characters: [], realistic: route === 'money_shot' });
const est = (inr, voice = 10) => ({ total_inr: null, priced_inr: 0, voice_inr: voice, shots: inr.map((v, idx) => ({ idx, route: 'x', duration_s: 0, inr: v, basis: v === null ? 'no rate' : 'rate' })), unpriced: [], usd_inr_rate: 88 });
const pol = { capInr: 150, overlayMinShare: 0.5, characterBeatMaxS: 8, moneyShotMax: 1 };
let f = fitToCap([shot('overlay', 30), shot('character_beat', 4), shot('money_shot', 6)], est([0, 20, null]), pol);
check(f.shots[2].route === 'overlay' && f.swaps[0].reason.startsWith('unpriced'), 'an unpriced money shot becomes an overlay, with the reason');
f = fitToCap([shot('overlay', 30), shot('money_shot', 4), shot('money_shot', 4)], est([0, 10, 10]), pol);
check(f.shots.filter((s) => s.route === 'money_shot').length === 1, 'a second money shot is swapped');
f = fitToCap([shot('overlay', 40), shot('character_beat', 6), shot('character_beat', 5)], est([0, 10, 10]), pol);
check(f.shots[1].route === 'overlay' && f.shots[2].route === 'character_beat', '11 s of character beats → the longest (6 s) is swapped, leaving 5 s');
f = fitToCap([shot('overlay', 10), shot('character_beat', 8), shot('acted_beat', 8)], est([0, 10, 10]), pol);
const ov = f.shots.filter((s) => s.route === 'overlay').reduce((n, s) => n + s.duration_s, 0);
check(ov / 26 >= 0.5, 'overlay share is raised to at least 50% of runtime', `${ov}/26`);
f = fitToCap([shot('overlay', 40), shot('character_beat', 4), shot('money_shot', 4)], est([0, 60, 100], 10), pol);
check(f.shots[2].route === 'overlay' && f.shots[1].route === 'character_beat', '₹170 > ₹150 → the priciest shot (₹100) goes, ₹70 stays');

console.log('\nscript lines\n');
const p = parseScript('Pip: Where is it?\nMrs. Iyer: Filed.\nmrs iyer: Twice.\nDirector Ohm: Noted.\n\nComplaint Box: Why?');
check(p.ok && p.lines.map((l) => l.speaker).join() === 'pip,iyer,iyer,ohm,complaint_box', 'speakers resolve by name, surname and case', JSON.stringify(p));
check(p.ok && p.voText === 'Where is it? Filed. Twice. Noted. Why?' && p.lines[1].voStart === 13 && p.lines[1].voEnd === 19, 'VO text joins lines with one space; offsets index into it');
const bad = parseScript('Pip: ok\nGandalf: no\njust words');
check(!bad.ok && bad.problems.length === 2, 'an unknown speaker and an unlabelled line are both reported', JSON.stringify(bad));
check(speakerSlug('The Auditor') === 'auditor' && speakerSlug('auditor') === 'auditor', '"The Auditor" and "auditor" are one speaker');

console.log('\ncomments\n');
check(characterMentions('Mrs Iyer is the best, and Pip too').sort().join() === 'iyer,pip', 'mentions find Mrs Iyer (no dot) and Pip');
check(characterMentions('I sat on a box and pipped it').length === 0, '"box" and "pipped" are not characters');
check(complaintScore({ body: 'Why does the Moon get to leave whenever it wants? Unfair.', is_public: true, like_count: 10 }) > 0.6, 'a specific public complaint scores high');
check(complaintScore({ body: 'Why does the Moon get to leave whenever it wants? Unfair.', is_public: false, like_count: 10 }) === 0, 'a private comment scores 0 — it can never be credited');

console.log('\nrouter and voice routing\n');
check(modelFor('policy_judge') === 'claude-opus-5-5' && modelFor('weekly_strategy') === 'claude-opus-5-5', 'judge and strategy → Opus');
check(['brief', 'script_polish', 'shotlist'].every((t) => modelFor(t) === 'claude-sonnet-5-5'), 'briefs, scripts, shotlists → Sonnet');
check(['dedup', 'metadata', 'qc_triage', 'comment_mining'].every((t) => modelFor(t) === 'claude-haiku-4-5-20251001'), 'dedup, metadata, QC triage, comment mining → Haiku');
check(Object.keys(TASK_TIER).length === 11 && modelFor('translation') === 'claude-haiku-4-5-20251001', 'eleven routed tasks; caption translation is fast-tier');
check(voiceRouteFor({ name: 'Pip', voice: { provider: 'runway', preset_id: null } }).code === 'voice_not_locked', 'an unlocked preset refuses with a reason');
check(voiceRouteFor({ name: 'Pip', voice: { provider: 'runway', preset_id: 'Maya' } }).voiceId === 'Maya', 'a locked preset routes to it');
check(voiceRouteFor({ name: 'Pip', voice: { provider: 'elevenlabs', preset_id: null }, elevenlabs_voice_id: null }).code === 'direct_voice_missing', 'the direct path needs its id');
check(resolvePunchline(['a', 'b', 'c'], ' b ').text === 'b' && resolvePunchline(['a', 'b', 'c'], 'my own line').choice === 'custom', 'punchline letters resolve; anything else is custom');

console.log('\nlong-form segments\n');
const scene = (purpose, lines, secs, route = 'overlay') => ({ type: 'scene', purpose, lines, shots: [{ route, description: 'x x x', duration_s: secs, characters: [], realistic: false }] });
const box = scene('Complaint Box moment', 'Complaint Box: Why?\nMarlo: Because.', 40);
const aired = { S001: 200, S002: 200, S003: 150 };
const good = [scene('cold open', 'Pip: Previously.', 40), { type: 'short', slot_id: 'S001' }, box, { type: 'short', slot_id: 'S002' }, scene('bridge', 'Marlo: Meanwhile.', 40), { type: 'short', slot_id: 'S003' }, scene('ending', 'Pip: Next week.', 30)];
check(validateSegments(good, aired).length === 0, 'cold open, three aired Shorts each framed by new scenes, 700 s, 21% new → accepted', JSON.stringify(validateSegments(good, aired)));
check(validateSegments([good[0], { type: 'short', slot_id: 'S001' }, { type: 'short', slot_id: 'S002' }, box], aired).some((p) => /back to back/.test(p)), 'two aired Shorts back to back is re-stitching, refused');
check(validateSegments([{ type: 'short', slot_id: 'S001' }, ...good.slice(1)], aired).some((p) => /cold open/.test(p)), 'opening on an aired Short is refused');
check(validateSegments(good.filter((s) => s !== box), aired).some((p) => /Complaint Box/.test(p)), 'no Complaint Box moment is refused');
check(validateSegments([scene('cold open', 'Pip: hi.', 10), { type: 'short', slot_id: 'S001' }, box], aired).some((p) => /8–12 minutes/.test(p)), '240 s is too short for long-form');
check(validateSegments([scene('cold open', 'Pip: hi.', 95, 'character_beat'), { type: 'short', slot_id: 'S001' }, box, { type: 'short', slot_id: 'S002' }, scene('end', 'Pip: bye.', 60)], aired).some((p) => /90 s/.test(p)), 'more than 90 s of generated character beats is refused');
check(validateSegments([scene('cold open', 'Pip: hi.', 5), { type: 'short', slot_id: 'S001' }, scene('Complaint Box', 'Complaint Box: x', 5), { type: 'short', slot_id: 'S002' }, scene('b', 'Pip: y.', 5), { type: 'short', slot_id: 'S003' }, scene('e', 'Pip: z.', 100)], { S001: 250, S002: 250, S003: 200 }).some((p) => /at least 20%/.test(p)), 'new scenes under 20% of the runtime is refused');
check(validateSegments([good[0], { type: 'short', slot_id: 'S099' }, box], aired).some((p) => /no aired master/.test(p)), 'a Short that never aired cannot be replayed');

console.log(failures ? `\n${failures} FAILED\n` : '\nAll Bureau rule checks passed.\n');
process.exit(failures ? 1 : 0);
