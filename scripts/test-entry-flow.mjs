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
const { STEPS } = await import(`${B}/steps.js`);

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

console.log(
  failed === 0
    ? '\nEvery path accounted for.\n'
    : `\n${failed} check(s) failed.\n`,
);
process.exit(failed === 0 ? 0 : 1);
