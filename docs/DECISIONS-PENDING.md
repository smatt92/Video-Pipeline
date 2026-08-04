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
