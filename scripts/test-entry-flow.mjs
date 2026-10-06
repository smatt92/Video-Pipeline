#!/usr/bin/env node
/**
 * The entry flow, exercised as a truth table.
 *
 * `entryDestination` decides who reaches the app, who is shown the product tour, and who is
 * sent to sign in. It runs in middleware, on every request, where a wrong answer is either
 * a redirect loop or an open door — and where it is the hardest code in the app to observe.
 *
 * So it is a pure function over three booleans, and this enumerates all eight combinations
 * rather than testing the two anybody thought of.
 *
 *   pnpm test:entry
 */
import { existsSync } from 'node:fs';

const B = '../.verify-build/src/lib/onboarding';
if (!existsSync(new URL(`${B}/entry.js`, import.meta.url))) {
  console.error('Compile first: npx tsc -p tsconfig.verify.json');
  process.exit(2);
}

const { entryDestination, reconcileSeen, DEFERRABLE_STEPS } = await import(`${B}/entry.js`);
const { STEPS, stepBySlug, firstIncompleteSlug, stepNeighbours } = await import(`${B}/steps.js`);
const { integrationForStep } = await import(`${B}/step-integration.js`);

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${got}, want ${want}`}`);
  if (!ok) failed++;
};

console.log('\nEntry flow\n');
console.log('1. All eight combinations of (signedIn, seenOnRecord, seenCookie)\n');

// seenOnRecord is null when there is no profile to read — an anonymous visitor, or a
// signed-in user whose row has not been created yet. That third state is why this is eight
// rows and not four.
const CASES = [
  // signedIn, seenOnRecord, seenCookie, expected
  [true,  true,  true,  'app'],
  [true,  true,  false, 'app'],
  [true,  false, true,  'onboarding'], // the column wins: seen on another browser is not seen here
  [true,  false, false, 'onboarding'],
  [true,  null,  true,  'app'],        // no row yet, cookie is the only evidence and it says yes
  [true,  null,  false, 'onboarding'],
  [false, null,  true,  'login'],      // anonymous, already toured — send them to sign in
  [false, null,  false, 'onboarding'], // anonymous, never toured — THE public path
];

for (const [signedIn, seenOnRecord, seenCookie, want] of CASES) {
  const got = entryDestination({ signedIn, seenOnRecord, seenCookie }).to;
  eq(`signedIn=${signedIn} record=${seenOnRecord} cookie=${seenCookie}`, got, want);
}

console.log('\n2. The column outranks the cookie\n');
{
  // A person who saw the tour on their laptop must not see it again on their phone, where
  // there is no cookie. That is the whole reason the column exists.
  const phone = entryDestination({ signedIn: true, seenOnRecord: true, seenCookie: false });
  eq('seen on record, no cookie on this device', phone.to, 'app');

  // And the reverse: a stale cookie must not let someone past a record that says otherwise.
  const stale = entryDestination({ signedIn: true, seenOnRecord: false, seenCookie: true });
  eq('record says not seen, cookie says seen', stale.to, 'onboarding');
}

console.log('\n3. Reconciliation at first sign-in\n');
{
  const now = new Date('2026-08-03T12:00:00Z');

  const carried = reconcileSeen({ seenOnRecord: false, seenCookie: true, now });
  eq('anonymous tour is carried onto the row', carried?.onboarding_seen_at, now.toISOString());

  const already = reconcileSeen({ seenOnRecord: true, seenCookie: true, now });
  eq('an existing record is not overwritten', already, null);

  const nothing = reconcileSeen({ seenOnRecord: false, seenCookie: false, now });
  eq('nothing to carry means no write', nothing, null);
}

console.log('\n4. Deferral covers every step\n');
{
  eq('every wizard step is deferrable', DEFERRABLE_STEPS.length, STEPS.length);
  const missing = STEPS.filter((s) => !DEFERRABLE_STEPS.includes(s.n)).map((s) => s.n);
  eq('none left out', missing.join(',') || '(none)', '(none)');
}

console.log('\n5. /setup never 404s: its redirect is a slug the wizard resolves, for every state\n');
{
  // /setup used to redirect to /setup/1 while the page resolves slugs only, so the index of
  // the wizard was a 404. Every subset of completed steps, crossed with three deferral sets,
  // must land on a slug `stepBySlug` resolves and that the person can act on.
  const ns = STEPS.map((s) => s.n);
  const deferrals = [[], [4, 5], ns];
  let states = 0;
  let unresolved = 0;
  for (let mask = 0; mask < 1 << ns.length; mask++) {
    const completed = ns.filter((_, i) => mask & (1 << i));
    for (const deferred of deferrals) {
      states++;
      const slug = firstIncompleteSlug(completed, deferred);
      const step = stepBySlug(slug);
      if (!step) unresolved++;
    }
  }
  eq(`every one of ${states} states redirects to a slug that resolves`, unresolved, 0);
  eq('nothing done → the first step', firstIncompleteSlug([], []), STEPS[0].slug);
  eq('everything done → still a real step', !!stepBySlug(firstIncompleteSlug(ns, [])), true);
  const req = STEPS.filter((s) => s.required);
  eq('first required step done → the next required one in walk order',
    firstIncompleteSlug([req[0].n], []), req[1].slug);
  eq('a numeric path is not a step (what /setup/1 was)', stepBySlug('1'), undefined);
}

console.log('\n6. The footer walks every step once, in list order\n');
{
  const forward = [];
  let cur = STEPS[0];
  while (cur && forward.length <= STEPS.length) {
    forward.push(cur.n);
    cur = stepNeighbours(cur).next;
  }
  eq('next → visits all steps in order', forward.join(','), STEPS.map((s) => s.n).join(','));
  const back = [];
  cur = STEPS[STEPS.length - 1];
  while (cur && back.length <= STEPS.length) {
    back.push(cur.n);
    cur = stepNeighbours(cur).prev;
  }
  eq('prev → visits all steps in reverse', back.join(','), STEPS.map((s) => s.n).reverse().join(','));
  eq('step 11 has a next (it had none)', stepNeighbours(STEPS.find((s) => s.n === 11)).next?.n ?? null,
    STEPS[STEPS.findIndex((s) => s.n === 11) + 1].n);
}

console.log('\n7. Steps 4 and 5 configure one integration; 11 another; 6 and 10 wait for 11\n');
{
  eq('generation and voice resolve to the same integration', integrationForStep(4), integrationForStep(5));
  eq('embeddings resolves to a different one', integrationForStep(11) !== integrationForStep(4) && integrationForStep(11) !== null, true);
  eq('rate card waits for embeddings', STEPS.find((s) => s.n === 6).blockedBy.includes(11), true);
  eq('first video waits for embeddings', STEPS.find((s) => s.n === 10).blockedBy.includes(11), true);
}

console.log('\n8. No link into the wizard is numeric\n');
{
  const { execFileSync } = await import('node:child_process');
  const grep = (re) => {
    try {
      return execFileSync('grep', ['-rnE', re, 'src'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  // Positive control first: the slug form must be found, or an empty result below means the
  // search could not see anything rather than that nothing is there.
  const control = grep('/setup/\\$\\{[a-z]+\\.slug\\}');
  eq('control: slug links are found', control.length > 0, true);
  const numeric = grep("/setup/([0-9]|\\$\\{[a-zA-Z.]*\\.n\\})").filter((l) => !/^\S+:\d+:\s*(\*|\/\/)/.test(l));
  eq('no /setup/<number> or /setup/${step.n} outside comments', numeric.join(' | ') || '(none)', '(none)');
}

console.log(
  failed === 0
    ? '\nEvery path accounted for.\n'
    : `\n${failed} check(s) failed.\n`,
);
process.exit(failed === 0 ? 0 : 1);
