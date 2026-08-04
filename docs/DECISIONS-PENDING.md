# Decisions pending

Queued rather than asked, per the standing orders for unattended work. Each has the options
and a recommendation. Nothing here is blocking — the queue moved on past all of them.

---

## 1. `v_entry_state` — keep, delete, or wire

**Status:** unread since it was created. Verified independently before writing this, twice:

- `middleware.ts:244` and `(splash)/page.tsx:50` both select `profiles.onboarding_seen_at`
  directly. Neither touches `setup_complete`.
- The deferral banner reads `v_deferred_steps`, a different view, which is read.
- `grep -rn setup_complete src/` outside generated types: **nothing**.

The view's own comment says it exists because *"two independent booleans … reading them as
one value is the mistake this view exists to make hard."* No caller reads both, and one of
the two is read by nothing at all — so the mistake it prevents cannot currently be made.
That is the same shape as the fourth workspace gate that was dropped in §10a: a guard for a
state no write path produces.

**Options**

| | |
|---|---|
| A. Delete it | Honest today. Costs the next person the analysis above if the second boolean ever gets a reader. |
| B. Keep, and record why | No code changes. Leaves a view nobody reads, which is the thing being swept for. |
| C. Wire middleware to it | Puts a wider read on a hot path that needs one column, to prevent a mistake nobody is positioned to make. |

**Recommendation: B, then A when `setup_complete` gets a reader or is dropped.** Not A now,
because the project's own lesson from `v_shot_readiness` was that deleting a near-twin on
suspicion is how the wrong copy goes — and unlike that case this one is not a duplicate of
anything, so there is no second implementation to converge on. C is the vacuous-precondition
failure built deliberately.

---

## 2. `v_referral_attribution` — needs a surface, and the surface needs copy

**Status:** unread. Genuinely distinct from `v_partner_rollup`, which *is* read —
`v_partner_rollup` is volume and cost by month and driver; this is **signups attributable to
Kiln**, by vendor and by where in the product the click came from.

Its own comment carries the load-bearing part: *"accounts_verified is the honest denominator
for any conversion claim: a connected integration that never verified is a form somebody
filled in, not a win."*

The natural home is Settings → Integrations, beside the referral link that mints the code.
What stops it being built unattended is that it is a **conversion-reporting surface** — the
framing decides whether it reads as an internal diagnostic or as a number to quote at a
vendor, and that is a copy and positioning judgement rather than a technical one.

**Options**

| | |
|---|---|
| A. A quiet diagnostic panel | "3 connected, 1 verified" beside the link. Honest, no framing risk. |
| B. A partner-facing figure | Same data, presented as a conversion rate. Wants the verified denominator prominent or it overstates. |
| C. Leave unread until there is a partner conversation to have | Zero work; the view keeps not being read. |

**Recommendation: A.** The `accounts_verified` denominator makes B safe only if the copy
carries it, and the copy is yours. A is useful immediately and cannot mislead — and it
converts B into a copy change later rather than a build.

---

## 3. The reconcile figure, when a credit-balance delta becomes observable

**Status:** already decided in principle — *never write a measurement you did not take* — and
implemented as `cost_source = 'rate_card'` with `/costs` labelling the average. This is the
follow-on question, recorded so it is not re-derived.

When a balance delta *is* observable, the reconcile can be written. The open question is
**what to do with the difference** when the measured figure disagrees with the estimate that
preceded it: the ledger will then hold two rows about one charge that do not agree.

**Options**

| | |
|---|---|
| A. Reconcile supersedes, estimate retained | Already the view's behaviour. The disagreement stays visible in the rows. |
| B. Write a third `adjustment` row for the delta | Every row multiplies out; the audit trail is explicit. More rows. |
| C. Reconcile supersedes silently | Simplest, and loses the evidence that our rate card is wrong — which is the most valuable thing the disagreement tells us. |

**Recommendation: A, with the delta surfaced on `/costs`.** C throws away the signal. B is
correct accounting but the ledger already keys `(generation_id, entry_kind)`, so A gets the
same visibility for no schema change. Not C under any circumstances.

---

## 4. `@remotion/renderer` — the dependency stage 7's final render needs

**Status:** blocking the second half of item 6. `remotion` and `@remotion/player` are
installed and named in CLAUDE.md's stack; `@remotion/renderer` — the package that actually
produces a file server-side — is **not installed**, and CLAUDE.md's rule is to ask before
adding a dependency it does not name.

What shipped without it: `src/lib/assemble/composition.ts`, the composition's input
contract — cues, hook window, per-format safe box, frame count — with `verify:assemble` §9
exercising it against synthetic timings. That is deliberately the half where the bugs live
(a caption outliving the file, a hook under the platform's chrome, a duration nobody
measured) and it needs no renderer.

What it cannot do without the dependency: produce an MP4.

**Options**

| | |
|---|---|
| A. Add `@remotion/renderer` | The intended path. It is a large install with a headless-Chromium dependency, and it runs in `src/trigger/` only — rule 3 forbids it on Vercel anyway. |
| B. Burn captions with ffmpeg `drawtext` instead | No new dependency; ffmpeg is already required. Loses everything Remotion is for — the hook typography, transitions, anything that is not a subtitle. |
| C. Leave the final render unbuilt | Rough cut only. Phase 1 publishes by hand, so a rough cut is arguably shippable. |

**Recommendation: A, when you are awake to approve it.** B is a real fallback and worth
knowing exists, but it makes the final render a different product from the one the
composition plan was designed for, and `composition.ts` would then be describing a layout
nothing implements — a plan with no consumer, which is the pattern this project keeps
deleting.

**One thing to check before A:** `@remotion/renderer` downloads a Chromium at install. The
Trigger.dev build extension already declares ffmpeg (`check:trigger-build` enforces that
every binary `src/` spawns is declared) — it will need the same treatment, and that check
is what will tell you so.

---

## 5. Safe-area insets have never been checked against a real post

`SAFE_AREAS` in `composition.ts` carries `verified: false` on every entry and every plan it
produces reports that as a problem. The numbers are conservative guesses at where each
platform's own chrome sits.

Fifteen seconds each, on a phone, once there is a video to post: play one, note where the
title, handle and action rail actually land, and set the fractions. Until then the flag says
the insets are unmeasured, which is the honest state — and captions under the follow button
look like a design choice rather than a bug, so nothing else would catch it.

No options and no recommendation. It needs eyes on a handset, which is yours.
