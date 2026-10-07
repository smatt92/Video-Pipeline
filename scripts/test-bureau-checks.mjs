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
const { policyLint, classifySource, properNameCandidates, castNames } = require(`${B}/bureau/policy-lint.js`);
const { checkVariation, isoWeek, variationRefusal } = require(`${B}/bureau/variation.js`);
const { fitToCap } = require(`${B}/bureau/estimate.js`);
const { parseScript, speakerSlug, punchlineTurns } = require(`${B}/bureau/script-lines.js`);
const { characterMentions, complaintScore } = require(`${B}/bureau/comments.js`);
const { modelFor, TASK_TIER } = require(`${B}/llm/router.js`);
const { voiceRouteFor } = require(`${B}/drivers/voice-route.js`);
const { resolvePunchline } = require(`${B}/bureau/briefs.js`);
const { validateSegments } = require(`${B}/bureau/longform.js`);
const { providersForRoute, failoverEnabled } = require(`${B}/drivers/jobs.js`);
const { videoRequestBody, imageRequestBody, clipSeconds, clipCredits } = require(`${B}/drivers/video-runway.js`);
const { embedTexts, EMBED_ATTEMPTS } = require(`${B}/drivers/embeddings.js`);
const { resolveReferenceFrame } = require(`${B}/bureau/dispatch.js`);
const { bibleForSlug, templateBible } = require(`${B}/bureau/bible.js`);
const CB = bibleForSlug('bureau-of-reality');
const BIBLE = CB.bible;
const { framePrompt } = require(`${B}/bureau/frames.js`);

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
  const r = policyLint({ script_text: script, fact }, CB);
  check(r.status === 'fail' && r.violations.map((v) => v.rule).join() === rule, `${rule} is caught and nothing else is`, JSON.stringify(r.violations));
}
const clean = policyLint({ series: 'incident', script_text: 'Pip: Where is the Moon?\nMarlo: Gone. Tides shrink by Friday.', fact }, CB);
check(clean.status === 'pass' && clean.fact.source_class === 'met_ocean_agency', 'a clean script with a NOAA fact passes', JSON.stringify(clean));
check(policyLint({ script_text: 'Pip: hi there all.', facts: [fact, fact] }, CB).violations.some((v) => v.rule === 'fact_count'), 'two facts fail "exactly one"');
check(policyLint({ script_text: 'Pip: hi there all.', fact: { ...fact, source_url: 'https://someblog.example.com/moon' } }, CB).violations.some((v) => v.rule === 'fact_source_class'), 'a blog source fails the primary-source rule');
check(policyLint({ series: 'myth', script_text: 'Kaz: The serpent swallows the sun.', fact: { ...fact, source_url: 'https://www.britishmuseum.org/x' } }, CB).violations.some((v) => v.rule === 'myth_unlabelled'), 'a Myth Desk script without an interpretation marker fails');
check(policyLint({ series: 'myth', script_text: 'Kaz: Tradition holds the serpent swallows the sun.', fact: { ...fact, source_url: 'https://www.britishmuseum.org/x' } }, CB).status === 'pass', 'with "tradition holds" it passes');
check(policyLint({ script_text: 'Pip: ' + 'word '.repeat(151), fact }, CB).violations.some((v) => v.rule === 'script_length'), '151 words fails the 150-word limit');
check(policyLint({ script_text: 'Pip: ' + 'word '.repeat(149), fact }, CB).violations.length === 0, '150 words passes');
check(policyLint({ script_text: 'Pip: hi there all.', fact, music_bed: 'nursery rhyme for little ones' }, CB).violations.some((v) => v.rule === 'kid_coded'), 'kid-coded styling in the music bed is caught');
const titles = [{ text: 'a b c', hook_archetype: 'question' }, { text: 'd e f', hook_archetype: 'question' }, { text: 'g h i', hook_archetype: 'warning' }];
check(policyLint({ script_text: 'Pip: hi.', fact, titles }, CB).violations.some((v) => v.rule === 'title_archetypes'), 'two titles with one archetype fail');
const judge = policyLint({ script_text: 'Pip: Ravi Kumar from accounts called.', fact }, CB);
check(judge.status === 'needs_judge' && judge.judge_questions.length === 1, 'an unknown two-word name goes to the judge, not a pass', JSON.stringify(judge));
check(properNameCandidates('Marlo stamped "Gravitationally Unavailable" in Lost Property.', castNames(CB)).length === 0, 'stamps, labels and office nouns are not names');
check(properNameCandidates('Mrs. Iyer and Director Ohm met.', castNames(CB)).length === 0, 'the cast is not a judge question');

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
const refused = checkVariation({ ...base }, [], policy, { checked: false, reason: 'embeddings vendor rate-limited (429) on all 4 attempts' });
check(refused.status === 'refused' && refused.passed === false && refused.similarity.ok === null && refused.similarity.max === undefined,
  'no similarity → refused, never passed, and no score at all (not 0)', JSON.stringify(refused.similarity));
check(refused.refused_reason === 'similarity not computed — embeddings vendor rate-limited (429) on all 4 attempts', 'the refusal carries the vendor’s reason verbatim', refused.refused_reason);
check(variationRefusal(refused) === refused.refused_reason && variationRefusal({ status: 'incomplete', similarity: { checked: false, reason: 'no key' } }) === 'similarity not computed — no key',
  'a stored refusal blocks approval, including the pre-0044 spelling "incomplete"');
check(variationRefusal(null) !== null && variationRefusal(fourDiff) === null && variationRefusal(threeSame) === null, 'no stored result blocks; a pass or a computed fail does not (a fail is the approver’s call)');
const emptyHistory = checkVariation({ ...base }, [], policy, { checked: true, max: null, nearest_brief_id: null, compared: 0 });
check(emptyHistory.status === 'pass' && emptyHistory.similarity.max === null, 'nothing to compare → pass with max null, not 0');
const window = Array.from({ length: 20 }, (_, i) => row(`r${i}`, `2026-09-${String(i + 1).padStart(2, '0')}`, i < 6 ? {} : { series: 'deep', lead: 'marlo', desk: 'a', premise_type: 'b', structure_variant: 'c', hook_archetype: 'warning' }));
const windowed = checkVariation({ ...base, hook_archetype: 'question', on_date: '2026-10-21' }, window, policy, sim);
check(windowed.compared_against === 14 && windowed.status === 'pass', 'only the last 14 by air date are compared (the 6 clones are older)', `${windowed.compared_against} ${windowed.status}`);

console.log('\nfitToCap\n');
const shot = (route, d) => ({ route, description: 'x x x', duration_s: d, characters: [], realistic: route === 'money_shot' });
// The fitter reads planned_inr (one call × the re-roll allowance) — the per-call `inr` is set
// to something else on purpose, so a fitter that read the wrong field fails these.
const est = (inr, voice = 10) => ({ total_inr: null, priced_inr: 0, voice_inr: voice, shots: inr.map((v, idx) => ({ idx, route: 'x', duration_s: 0, billed_s: null, inr: v === null ? null : 0.01, planned_inr: v, basis: v === null ? 'no rate' : 'rate' })), unpriced: [], usd_inr_rate: 88 });
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

console.log('\ngeneration on the Runway API (0015)\n');
check(providersForRoute('character_beat', { failover: false }).join() === 'runway' && providersForRoute('money_shot', { failover: false }).join() === 'runway' && providersForRoute('acted_beat', { failover: false }).join() === 'runway',
  'failover off: every generated route goes to the one vendor and nowhere else');
check(providersForRoute('character_beat', { failover: true }).join() === 'runway,higgsfield,fal' && providersForRoute('money_shot', { failover: true }).join() === 'runway,gemini',
  'failover on: the dormant vendors follow, primary first');
let threw = null;
try { failoverEnabled('true'); } catch (err) { threw = err.message; }
check(failoverEnabled(undefined) === false && failoverEnabled('on') === true && /must be "off" or "on"/.test(threw ?? ''), 'GENERATION_FAILOVER defaults off, and "true" is refused rather than read as off', threw);
check(clipSeconds('gen4_turbo', 1.2) === 2 && clipSeconds('gen4_turbo', 4.6) === 5 && clipSeconds('gen4_turbo', 8) === 8 && clipSeconds('gen4_turbo', 12) === 10, 'gen4_turbo bills whole seconds, 2 to 10');
check(clipSeconds('veo3.1_fast', 3.2) === 4 && clipSeconds('veo3.1_fast', 4.1) === 6 && clipSeconds('veo3.1_fast', 9) === 8, 'veo3.1_fast bills 4, 6 or 8 only');
check(clipCredits('gen4_turbo', 8) * 1.5 === 60 && clipCredits('veo3.1_fast', 4) * 1.5 === 60, 'per-Short arithmetic: an 8 s beat × 1.5 re-rolls = 60 credits; a 4 s money shot × 1.5 × 10 = 60');
const veo = videoRequestBody('veo3.1_fast', { prompt: 'A wave breaks over a lighthouse', duration_s: 3.2, aspect_ratio: '9:16', negative_prompt: 'text' });
check(veo.ok && veo.body.audio === false && Object.prototype.hasOwnProperty.call(veo.body, 'audio'), 'LOAD-BEARING: Veo is sent audio:false explicitly — the key is present, not omitted', JSON.stringify(veo.body));
check(veo.ok && veo.path === '/text_to_video' && veo.body.duration === 4 && veo.body.ratio === '720:1280' && veo.body.promptImage === undefined, 'no start frame → text-to-video, 4 s, 720:1280');
const veoI = videoRequestBody('veo3.1_fast', { prompt: 'x', duration_s: 6, image_url: 'https://e.test/f.png' });
check(veoI.ok && veoI.path === '/image_to_video' && veoI.body.audio === false && veoI.body.promptImage[0].position === 'first', 'with a start frame → image-to-video, still audio:false');
const g4 = videoRequestBody('gen4_turbo', { prompt: 'x', duration_s: 7.4, image_url: 'https://e.test/f.png' });
check(g4.ok && g4.body.duration === 8 && g4.body.ratio === '720:1280' && !('audio' in g4.body), 'gen4_turbo: 8 s, 720:1280, no audio field (the model has none)');
const g4noRef = videoRequestBody('gen4_turbo', { prompt: 'x', duration_s: 4 });
check(!g4noRef.ok && /different-looking character/.test(g4noRef.detail), 'gen4_turbo without a frame is refused before any call', g4noRef.detail);
check(!videoRequestBody('gen4_turbo', { prompt: 'x'.repeat(1001), duration_s: 4, image_url: 'https://e.test/f.png' }).ok, 'a prompt over 1000 characters is refused, not clipped');
check(!videoRequestBody('gen4_turbo', { prompt: 'x', duration_s: 4, image_url: 'https://e.test/f.png', aspect_ratio: '1:1' }).ok, 'an aspect with no ratio mapping is refused');
check(!imageRequestBody({ model: 'gen4_image_turbo', prompt: 'x', ratio: '720:1280', references: [] }).ok, 'gen4_image_turbo needs a reference image');
check(!imageRequestBody({ model: 'gen4_image', prompt: 'x', ratio: '720:1280', references: [{ uri: 'https://e.test/a.png', tag: 'p-1' }] }).ok, 'a reference tag with a hyphen is refused (3–16, letters/digits/underscore)');
const img = imageRequestBody({ model: 'gen4_image', prompt: 'x', ratio: '1080:1920', references: [{ uri: 'https://e.test/a.png', tag: 'pip_ref1' }] });
check(img.ok && img.body.referenceImages[0].tag === 'pip_ref1' && img.body.ratio === '1080:1920', 'gen4_image with a tagged reference');
check(BIBLE.characters.every((c) => framePrompt(c, CB.bible.world).length <= 1000), 'every character’s frame prompt fits the vendor’s 1000-character limit', String(Math.max(...BIBLE.characters.map((c) => framePrompt(c, CB.bible.world).length))));
const rf1 = await resolveReferenceFrame({ reference_frame: 'storage:characters/pip/ref.png', prompt: 'x' });
check(!rf1.ok && /no way to presign/.test(rf1.detail), 'a storage frame with no presigner is refused, not submitted without it');
const rf2 = await resolveReferenceFrame({ reference_frame: 'storage:characters/pip/ref.png' }, async (k) => `https://signed.test/${k}`);
check(rf2.ok && rf2.params.image_url === 'https://signed.test/characters/pip/ref.png' && !('reference_frame' in rf2.params), 'a storage frame resolves to image_url for the call');
const rf3 = await resolveReferenceFrame({ reference_frame: 'ref_pip' });
check(!rf3.ok, 'a vendor-side id that is neither storage nor https is refused');

console.log('\nembeddings on a free tier\n');
let calls = 0;
const slept = [];
const flaky = async () => (++calls <= 2
  ? new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '3' } })
  : new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0.1) }] }), { status: 200 }));
const e1 = await embedTexts(['hello'], 'k', flaky, async (ms) => { slept.push(ms); });
check(e1.ok && calls === 3 && slept.join() === '3000,3000', 'two 429s are waited out (Retry-After honoured) and the third call succeeds', `${calls} calls, slept ${slept.join()}`);
calls = 0;
const always = async () => { calls++; return new Response('{}', { status: 429 }); };
const e2 = await embedTexts(['hello'], 'k', always, async () => {});
check(!e2.ok && calls === EMBED_ATTEMPTS && /rate-limited \(429\) on all 4 attempts/.test(e2.detail), 'a vendor that keeps refusing is reported unavailable, by name, after the last attempt', e2.ok ? 'ok' : e2.detail);

console.log('\nscript lines\n');
const p = parseScript('Pip: Where is it?\nMrs. Iyer: Filed.\nmrs iyer: Twice.\nDirector Ohm: Noted.\n\nComplaint Box: Why?', CB);
check(p.ok && p.lines.map((l) => l.speaker).join() === 'pip,iyer,iyer,ohm,complaint_box', 'speakers resolve by name, surname and case', JSON.stringify(p));
check(p.ok && p.voText === 'Where is it? Filed. Twice. Noted. Why?' && p.lines[1].voStart === 13 && p.lines[1].voEnd === 19, 'VO text joins lines with one space; offsets index into it');
const bad = parseScript('Pip: ok\nGandalf: no\njust words', CB);
check(!bad.ok && bad.problems.length === 2, 'an unknown speaker and an unlabelled line are both reported', JSON.stringify(bad));
check(speakerSlug('The Auditor', CB) === 'auditor' && speakerSlug('auditor', CB) === 'auditor', '"The Auditor" and "auditor" are one speaker');
// S001's last line, verbatim: two turns on one line, once voiced entirely by Pip, names and all.
const two = parseScript('Marlo: You have till lunch.\nPip: Marlo: File it under— Pip: Missing?', CB);
check(
  two.ok && JSON.stringify(two.lines.map((l) => [l.speaker, l.text])) === JSON.stringify([['marlo', 'You have till lunch.'], ['marlo', 'File it under—'], ['pip', 'Missing?']]) &&
    two.voText === 'You have till lunch. File it under— Missing?' && two.lines[2].voStart === 36 && two.lines[2].voEnd === 44,
  'turns packed onto one line are split by speaker, and no cast name is spoken',
  JSON.stringify(two),
);
// S003's three punchlines, verbatim from the brief (07-Oct).
const pA = punchlineTurns("Pip: So I can't break gravity. / Marlo: Not alone. Meet your supervisor. / Ohm's lamp flickers on.", 'pip', CB);
check(JSON.stringify(pA) === JSON.stringify([{ speaker: 'pip', text: "So I can't break gravity." }, { speaker: 'marlo', text: 'Not alone. Meet your supervisor.' }]), 'a punchline exchange keeps its spoken turns and drops the stage direction', JSON.stringify(pA));
const pB = punchlineTurns("Pip lets go of the lanyard to test it; it falls; Marlo's mug keeps orbiting. Marlo: The mug has seniority.", 'pip', CB);
check(JSON.stringify(pB) === JSON.stringify([{ speaker: 'marlo', text: 'The mug has seniority.' }]), 'direction before the first label is not spoken', JSON.stringify(pB));
const { scriptAcceptable } = require(`${B}/bureau/episode-steps.js`);
const s003 = "Ohm: Memo. New intern, Gravity Desk. Touch nothing.\nPip: So I can't break gravity.\nMarlo: Not alone. Meet your supervisor.\nOhm: Welcome to the Gravity Desk.";
check(scriptAcceptable(s003, "Pip: So I can't break gravity. / Marlo: Not alone. Meet your supervisor. / Ohm's lamp flickers on.", 150, CB).ok, "S003's script is accepted with the punchline it actually speaks");
check(!scriptAcceptable(s003, "Marlo: The mug has seniority.", 150, CB).ok, 'and refused when the punchline is genuinely missing');
const pC = punchlineTurns("File it under 'falling'.", 'marlo', CB);
check(JSON.stringify(pC) === JSON.stringify([{ speaker: 'marlo', text: "File it under 'falling'." }]), 'an unlabelled punchline is one line for the lead', JSON.stringify(pC));
const notCast = parseScript('Marlo: Note: Desk Four: closed.', CB);
check(notCast.ok && notCast.lines.length === 1 && notCast.lines[0].text === 'Note: Desk Four: closed.', 'a colon after a word that is not in the cast stays as words');

console.log('\ncomments\n');
check(characterMentions('Mrs Iyer is the best, and Pip too', CB).sort().join() === 'iyer,pip', 'mentions find Mrs Iyer (no dot) and Pip');
check(characterMentions('I sat on a box and pipped it', CB).length === 0, '"box" and "pipped" are not characters');
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
check(validateSegments(good, aired, CB).length === 0, 'cold open, three aired Shorts each framed by new scenes, 700 s, 21% new → accepted', JSON.stringify(validateSegments(good, aired, CB)));
check(validateSegments([good[0], { type: 'short', slot_id: 'S001' }, { type: 'short', slot_id: 'S002' }, box], aired, CB).some((p) => /back to back/.test(p)), 'two aired Shorts back to back is re-stitching, refused');
check(validateSegments([{ type: 'short', slot_id: 'S001' }, ...good.slice(1)], aired, CB).some((p) => /cold open/.test(p)), 'opening on an aired Short is refused');
check(validateSegments(good.filter((s) => s !== box), aired, CB).some((p) => /Complaint Box/.test(p)), 'no Complaint Box moment is refused');
check(validateSegments([scene('cold open', 'Pip: hi.', 10), { type: 'short', slot_id: 'S001' }, box], aired, CB).some((p) => /8–12 minutes/.test(p)), '240 s is too short for long-form');
check(validateSegments([scene('cold open', 'Pip: hi.', 95, 'character_beat'), { type: 'short', slot_id: 'S001' }, box, { type: 'short', slot_id: 'S002' }, scene('end', 'Pip: bye.', 60)], aired, CB).some((p) => /90 s/.test(p)), 'more than 90 s of generated character beats is refused');
check(validateSegments([scene('cold open', 'Pip: hi.', 5), { type: 'short', slot_id: 'S001' }, scene('Complaint Box', 'Complaint Box: x', 5), { type: 'short', slot_id: 'S002' }, scene('b', 'Pip: y.', 5), { type: 'short', slot_id: 'S003' }, scene('e', 'Pip: z.', 100)], { S001: 250, S002: 250, S003: 200 }, CB).some((p) => /at least 20%/.test(p)), 'new scenes under 20% of the runtime is refused');
check(validateSegments([good[0], { type: 'short', slot_id: 'S099' }, box], aired, CB).some((p) => /no aired master/.test(p)), 'a Short that never aired cannot be replayed');

console.log('\nchannel bibles and voice overrides\n');
{
  const T = templateBible();
  check(T.slug === '_template' && T.bible.characters.length >= 1 && Object.keys(T.series).length >= 1, 'the template bible parses — Add channel copies something valid');
  let refusal = '';
  try { bibleForSlug('no-such-channel'); } catch (e) { refusal = e.message; }
  check(/channels\/no-such-channel\//.test(refusal) && /pnpm channel:new no-such-channel/.test(refusal), 'a slug without a folder is refused by name, with the command', refusal);
  let tmpl = '';
  try { bibleForSlug('_template'); } catch (e) { tmpl = e.message; }
  check(/No bible folder channels\/_template\//.test(tmpl), 'the template is never a channel’s bible', tmpl);
  // Cast is per channel: a Bureau name is not a speaker on the template channel.
  check(speakerSlug('Pip', CB) === 'pip' && speakerSlug('Pip', T) === null, 'a cast name resolves on its own channel only');
  const onBureau = properNameCandidates('Pip met Mrs Iyer today.', castNames(CB));
  const onTemplate = properNameCandidates('Pip met Mrs Iyer today.', castNames(T));
  check(onBureau.length === 0 && onTemplate.join() === 'Mrs Iyer', 'the Bureau cast is a judge question on another channel, not on its own', JSON.stringify({ onBureau, onTemplate }));

  const pip = CB.characterBySlug('pip');
  const bible = voiceRouteFor(pip);
  const over = voiceRouteFor(pip, { provider: 'runway', voiceId: 'Maya' });
  check(bible.ok && bible.voiceId === pip.voice.preset_id && bible.voiceId !== 'Maya', 'no override → the bible’s locked preset', JSON.stringify(bible));
  check(over.ok && over.voiceId === 'Maya' && over.provider === 'runway', 'an override wins over the bible', JSON.stringify(over));
  const badPreset = voiceRouteFor(pip, { provider: 'runway', voiceId: 'Nobody' });
  check(!badPreset.ok && /override is unusable/.test(badPreset.detail), 'an unusable override refuses by name — never a silent fall back to the bible', JSON.stringify(badPreset));
  const badProvider = voiceRouteFor(pip, { provider: 'acme', voiceId: 'x' });
  check(!badProvider.ok && /unknown voice provider "acme"/.test(badProvider.detail), 'an unknown provider refuses by name', JSON.stringify(badProvider));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll Bureau rule checks passed.\n');
process.exit(failures ? 1 : 0);
