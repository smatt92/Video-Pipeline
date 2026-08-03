'use client';

import Link from 'next/link';

/**
 * The fork.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The copy is the feature
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the highest-stakes screen in the entry flow, and the risk is not that someone
 * picks wrong — it is that "Skip" reads as an escape hatch. Escape-hatch copy produces two
 * bad outcomes and they pull in opposite directions: someone who wanted to look around
 * feels they are doing something irresponsible, and someone who skips arrives expecting a
 * crippled app and blames the product for a state they chose.
 *
 * So the two options are described symmetrically, in the same voice, at the same size, with
 * the same visual weight. Neither is styled as the accent-coloured "real" one. What differs
 * is the sentence describing the consequence, and the consequence is stated as a *fact*
 * about what will happen rather than as a warning about what will not.
 *
 * The specific thing skipping must convey: **you get a working app with nothing wired.**
 * Not a trial, not a limited mode, not read-only. Every screen renders, every refusal
 * explains itself, and nothing spends money because nothing is connected yet. That is a
 * real and useful state — it is the state the entire codebase is written to make legible,
 * which is why "Skip" can be offered honestly rather than apologetically.
 *
 * The word "Skip" is kept because it is what the person is looking for. Renaming it to
 * something softer — "Explore first", "Maybe later" — makes it harder to find and reads as
 * an attempt to steer, which is exactly the dark-pattern move this screen must not make.
 */

export function Fork({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-10">
      <h1 className="text-xl font-medium tracking-tight">That is Kiln.</h1>
      <p className="mt-2 max-w-[58ch] text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {signedIn
          ? 'Two ways in from here. Both open the app — the difference is only whether you connect your accounts now or later.'
          : 'Sign in and pick one of two ways in. Both open the app — the difference is only whether you connect your accounts now or later.'}
      </p>

      <div
        className="mt-8 grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))' }}
      >
        <Choice
          href={signedIn ? '/setup/1' : '/login?next=/setup/1'}
          heading="Set up your account"
          time="About fifteen minutes"
          body="Walk the eight steps: object storage, the language model, the video and voice vendors, your channel. Each step ends in a real call to the service, so when it says connected, something actually answered."
          consequence="At the end, the pipeline can run a video end to end."
        />

        <Choice
          href={signedIn ? '/board' : '/login?next=/board'}
          heading="Skip for now"
          time="Nothing to fill in"
          body="You get the whole application, with nothing connected to it yet. Every screen opens, every button is there, and anything that would need a vendor tells you which one and why — rather than failing quietly or hiding itself."
          consequence="Nothing can spend money until you connect something, because nothing is connected."
        />
      </div>

      {/*
        Placed under both, not under Skip. Attaching it to one choice would make that choice
        the one with a caveat, which is the asymmetry this screen is avoiding.
      */}
      <p className="mt-8 max-w-[62ch] text-xs leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        You can change your mind at any point — setup lives in Settings and there is a
        checklist in the sidebar that picks up wherever you left it. Skipping does not put the
        app in a reduced mode; there is no reduced mode. It just means the vendors are not
        connected yet, and Kiln is built to say so plainly on every screen where it matters.
      </p>
    </div>
  );
}

/**
 * Both options render through the same component, deliberately.
 *
 * Two components would let them drift apart in weight, spacing or tone one small edit at a
 * time, and the symmetry is the argument. If one of these ever needs to look different from
 * the other, that is a product decision worth making on purpose rather than a styling
 * change that happens to imply one.
 */
function Choice({
  href,
  heading,
  time,
  body,
  consequence,
}: {
  href: string;
  heading: string;
  time: string;
  body: string;
  consequence: string;
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
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {body}
      </p>
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {consequence}
      </p>
    </Link>
  );
}
