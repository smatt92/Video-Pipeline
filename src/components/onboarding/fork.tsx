'use client';

import Link from 'next/link';

import { REQUIRED_STEPS, STEPS } from '@/lib/onboarding/steps';

/**
 * The fork.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The copy is the feature
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The risk is not that someone picks wrong — it is that "Skip" reads as an escape hatch.
 * That produces two bad outcomes pulling in opposite directions: someone who wanted to look
 * around feels they are doing something irresponsible, and someone who skips arrives
 * expecting a crippled app and blames the product for a state they chose.
 *
 * So both options render through the same component at the same weight, and **both end on
 * capability**. An earlier draft closed Setup on what you gain and Skip on what cannot
 * happen — which is exactly the asymmetry this screen exists to avoid, arriving in the last
 * sentence where it does the most damage.
 *
 * ── "There is no reduced mode" sits in the Skip column, near the top ─────────
 *
 * It is the claim that makes Skip legitimate, so it cannot live in a footnote below where
 * anyone reads. Every screen renders, every refusal explains itself, and nothing spends
 * money because nothing is connected. That is a real and useful state — it is the state
 * this entire codebase is written to make legible, which is why Skip can be offered
 * honestly rather than apologetically.
 *
 * ── The step count is derived ────────────────────────────────────────────────
 *
 * It said "eight steps" and the wizard said "0 of 7 required", because one was typed and
 * the other counted. Any number a person can read in two places must come from one.
 *
 * ── Structure: one line above the fold, detail below ─────────────────────────
 *
 * This is read in about two seconds. Each option leads with its single strongest sentence —
 * for Setup that is the verification promise, which is the most credible thing on the page —
 * and puts the rest underneath for anyone still deciding.
 */

const OPTIONAL_STEPS = STEPS.length - REQUIRED_STEPS.length;

export function Fork({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-10">
      <h1 className="text-xl font-medium tracking-tight">That is Kiln.</h1>
      <p className="mt-2 max-w-[58ch] text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {signedIn ? 'Two ways in.' : 'Sign in, then pick one of two ways in.'} Both open the
        app — the difference is only whether you connect your accounts now or later.
      </p>

      <div
        className="mt-8 grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))' }}
      >
        <Choice
          href={signedIn ? '/setup/1' : '/login?next=/setup/1'}
          heading="Set up your account"
          time="About fifteen minutes"
          lead="Each step ends in a real call to the service, so when it says connected, something actually answered."
          body={`${REQUIRED_STEPS.length} required steps — object storage, the language model, the video and voice vendors, your channel — and ${OPTIONAL_STEPS} optional ones you can come back to.`}
          closing="At the end, the pipeline can run a video end to end."
        />

        <Choice
          href={signedIn ? '/board' : '/login?next=/board'}
          heading="Skip for now"
          time="Nothing to fill in"
          lead="The whole application, with nothing connected to it yet. There is no reduced mode."
          body="Every screen opens, every button is there, and anything that needs a vendor tells you which one and why — rather than failing quietly or hiding itself."
          closing="Connect things one at a time, in whatever order you need them."
        />
      </div>

      {/* Under both, not under Skip. Attaching it to one choice would make that the choice
          with a caveat, which is the asymmetry this screen is avoiding. */}
      <p className="mt-8 max-w-[62ch] text-xs leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        You can change your mind at any point — setup lives in Settings, and a checklist in the
        sidebar picks up wherever you left it.
      </p>
    </div>
  );
}

/**
 * Both options render through this, deliberately.
 *
 * Two components would let them drift apart in weight, spacing or tone one small edit at a
 * time, and the symmetry is the argument. If one ever needs to look different from the
 * other, that is a product decision worth making on purpose rather than a styling change
 * that happens to imply one.
 */
function Choice({
  href,
  heading,
  time,
  lead,
  body,
  closing,
}: {
  href: string;
  heading: string;
  time: string;
  /** The one line that has to survive a two-second scan. */
  lead: string;
  body: string;
  /** Always a capability, on both sides. See the note at the top. */
  closing: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-md border p-5 transition-colors"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border-default)',
        transitionDuration: 'var(--duration-fast)',
        minHeight: 'var(--hit-primary)',
      }}
    >
      <span className="text-md font-medium">{heading}</span>
      <span
        className="mt-1 font-mono text-2xs uppercase tracking-[0.09em]"
        style={{ color: 'var(--text-faint)' }}
      >
        {time}
      </span>

      <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {lead}
      </p>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {body}
      </p>
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {closing}
      </p>
    </Link>
  );
}
