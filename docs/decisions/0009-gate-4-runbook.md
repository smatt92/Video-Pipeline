# 0009 — Gate 4 runbook: the first real generation

**Status:** unwalked. Every step below is written from the code, not from having done it.

Gate 4 is the first thing only a preview deployment can prove, because it needs a publicly
reachable callback URL and this build environment has neither vendor access nor an inbound
route. So the point of this document is that the walk is *deliberate* — each step says what
it should produce, and what a failure at that point actually means, so a wrong result is
diagnosed rather than retried.

Read the failure column before you start. Three of these failures look identical from the
outside and have completely different causes.

---

## Before you begin

| Precondition | How to check | If it is not true |
|---|---|---|
| Migrations 0001–0015 pushed | `pnpm check:enums "<uri>"` against the hosted DB | `supabase db push` |
| The build is current | `/login` footer sha matches `git log -1` | Redeploy, cache off |
| Storage verified | Settings → Integrations shows `verified` | Onboarding step 2 |
| Video credentials verified | Same screen, video row | Onboarding step 4 |
| **Voice credentials verified** | Same screen, audio row | Onboarding step 5 — **see step 0.5** |
| A recipe exists | `/library/prompts` shows ≥1 active | An MCP session |
| A rate is verified | `/settings/rate-card` shows the credit rate as verified | See step 0 below |
| `WEBHOOK_CALLBACK_BASE_URL` is the preview origin | Vercel env | It must not be `APP_URL` if they differ |

---

## Step 0 — Verify one credit rate, by observation

**Do this first and separately.** Everything downstream refuses without it, and the refusal
is deliberate: an unverified rate means no rupee figure anywhere and a submit that must not
happen.

1. Note the account's credit balance in the vendor dashboard.
2. Generate one clip **in the vendor's own UI**, not through Kiln.
3. Note the balance again. The difference is the per-generation credit cost.
4. Settings → Rate card → enter it with a source note naming the observation.

**Produces:** one `rate_card` row with `is_verified = true`.

**If you skip it:** stage 5 throws before submitting anything, with the rate's own reason.
That is the system working. Do not work around it by marking a guess verified — the whole
cost-per-video metric derives from this number, and it cannot be backfilled.

---

## Step 0.5 — Voice credentials must be in before you start

**This is an ordering constraint, not a suggestion, and it is the one most likely to strand
you mid-run.**

The chain is: stage 6 (voice) sets `shots.duration_source = 'derived_from_vo'`, and stage 5
(video) **refuses any shot whose `duration_source` is still `'authored'`**. So video cannot
run until voice has, and voice cannot run until the audio integration has verified.

Which means the practical prerequisite is: **the voice vendor's credentials are entered and
verified in onboarding step 5 before Gate 4 begins.** Not before step 2 — before step 0.

Until now that ordering was implicit in a refusal message, which is the wrong place for it.
You would get through the rate-card observation, a script, a shotlist, and arrive at step 2
to find the leg blocked on a credential you could have entered an hour earlier, with a
verified rate already bought and a script already paid for.

**Check:** Settings → Integrations, audio row reads `verified`.

**If it does not:** stop here and finish onboarding step 5. Everything above this line is
cheap to redo; nothing below it is.

**Why the refusal is right, and must not be routed around.** Addendum 02 §1 inverts the DAG
deliberately: VO costs about a hundredth of video generation, so the durations are measured
from real speech and the video is generated to fit. Generating video against a word-count
estimate spends the expensive artifact to save the cheap one. If you find yourself wanting
to bypass the refusal, the thing to fix is the missing credential.

---

## Step 1 — A script and a shotlist

```
# From the Trigger dashboard, or pnpm verify:script for stage 3 alone
03-script     { conceptId }
04-prompt-compile { scriptId }
```

**Should produce:** a `scripts` row with `human_edit_count = 0`, 4–6 `shots` rows each with
a `shot_kind`, and `v_shot_readiness.generatable = true` for at least one.

**If `generatable` is false everywhere:** the library has no recipe for the kinds this
script produced. `/library/prompts` names which kinds and how many shots each is blocking.
That is a worklist, not an error.

---

## Step 2 — Voice, before video

```
06-voice { scriptId, voiceId }
```

**Should produce:** `vo_takes` rows with non-null `request_id`, and `shots.duration_source`
flipping to `derived_from_vo`.

**If `request_id` is null:** the vendor returns it somewhere other than the `request-id`
response header. Stitching is silently broken — chunk 2 will not inherit chunk 1's prosody,
and on a multi-chunk script the voice changes mid-way. This is the assumption in 0008 §4b
most likely to be wrong and the only one that fails without an error.

**If durations stay `authored`:** the shot spans and the synthesised text have drifted
apart. `deriveShotDurations` says which span matched nothing rather than collapsing it to
zero.

**Stage 5 refuses shots whose duration is still estimated.** That is not a bug to route
around — generating video against a word-count guess is exactly what the audio-first
ordering exists to prevent. Step 0.5 states this as a precondition so it is not discovered
here.

---

## Step 3 — Submit one shot

Start with **one**. Not the fan-out.

**Should produce:** one `generations` row, `kind = 'image'`, `status = 'queued'`, a non-null
`idempotency_key`, and — written *before* the submit — one `cost_ledger` row with
`entry_kind = 'estimate'`.

**Check the ordering explicitly:** the cost row must exist even if the submit failed. Rule 5
is that money moving without a row is the one failure this project cannot tolerate.

**If the cost row is missing but the generation exists:** the ordering is inverted somewhere
and every subsequent step will under-report. Stop and fix that before generating anything
else.

---

## Step 4 — The callback

This is the step Gate 4 exists for. Watch the Vercel function logs.

**Should produce, in order:** a POST to `/api/webhooks/higgsfield` → `webhook_received_at`
set → an outbound status fetch → `confirmed_at` set → `status = 'succeeded'`.

| What you see | What it means |
|---|---|
| No POST at all | `WEBHOOK_CALLBACK_BASE_URL` is wrong, or points at a preview URL that has since been superseded. The vendor got a DNS failure and will not retry. |
| POST, 401 | The shared secret Kiln holds and the one the vendor echoes differ. Rotate both to the same value; do not relax the comparison. |
| POST, 202, `webhook_received_at` set, `confirmed_at` null | The status fetch failed. Check the function log for the constructed URL — if it is malformed, `HIGGSFIELD_API_BASE_URL` is wrong. |
| `confirmed_at` set, `status` still `queued` | The vendor's status vocabulary differs from the regexes in `confirm.ts`. Read the logged status string and widen them. |
| `outcome: 'unknown_job'` | The callback named a job id no row of ours holds. Either the submit did not persist, or this is a probe from somebody who found the URL. |

**Should also produce:** `webhook_deliveries = 1`. If it is already higher on the first
callback, the vendor retried — read the function log before continuing.

### The three attacks, and they are different

The first version of this step called itself a replay test and tested only forgery. Both
of the checks below were there; the third, which is the one that needs no secret at all,
was named and not tested. Run all three.

**1. Wrong secret — forgery without the key.** POST the same body again with a deliberately
wrong secret header. Must return **401**, change nothing, and not increment
`webhook_deliveries`.

**2. Right secret, invented job id — forgery with the key.** POST with the correct secret
and a job id you made up. Must return **`unknown_job`** and make **no outbound request** —
check the log. A confirmation fetch here would mean the endpoint can be used as a request
proxy.

**3. Right secret, GENUINE body, sent twice — replay.** This is the one that needs nothing
but the ability to see one real delivery, and the vendor itself does it on any timeout.
Take the exact body and headers of the callback that already succeeded and send them again.

| Must happen | Where to look |
|---|---|
| `webhook_deliveries` goes to 2 | the `generations` row |
| `webhook_received_at` does **not** move | same row — it is the first arrival, permanently |
| `webhook_last_received_at` does move | same row |
| Outcome is `already_confirmed` | the 202 response body |
| **No second status fetch** | the function log — the fast path returns before any outbound call |
| `confirmed_at`, `status` and `completed_at` all unchanged | same row |
| **No second ingest enqueued, no second asset** | `assets` — exactly one row for the shot |
| The job appears in `v_replayed_callbacks` | query it, or watch the pipeline board badge |

**If any of the writes moved**, `confirm_generation_once` is not being used and the
compare-and-set has been bypassed somewhere. Stop: at Gate 4 that means a replayed callback
downloads and stores the asset twice, and once the soul → dop chain is wired it means a
replay submits a **second paid video generation**.

**A note on why the guarantee is in the database.** The application-level check in
`confirm.ts` — return early if `confirmed_at` is set — is a fast path, not the guarantee.
Two deliveries arriving at the same instant can both read null and both proceed. Only
`where confirmed_at is null` inside the UPDATE settles it, and only the caller that gets
`true` back may do anything that costs money.

---

## Step 5 — Ingest

**Not wired yet.** `confirmAndIngest` confirms and returns the asset URL; enqueuing the
download, normalisation and storage write is marked `TODO(gate-4)` in that file.

This is deliberate rather than forgotten: a Vercel route may not touch media bytes
(4.5 MB cap, no ffmpeg), so ingest belongs in a Trigger task, and writing that task before
a single confirmation had been observed would have meant guessing at the shape of the thing
it ingests.

**A generation that succeeds with no `assets` row is therefore expected at this gate**, and
the shot grid shows it as exactly that. Wiring the ingest is the first thing after a
confirmation is seen.

---

## Step 6 — The chain

Only after a still has succeeded end to end.

**Should produce:** a second `generations` row, `kind = 'video'`, with
`parent_generation_id` pointing at the still.

**The rule to verify by breaking:** make a still fail — a deliberately malformed prompt will
do — and confirm **no video generation row appears and no second cost row is written**. A
video generated from a still that does not exist cannot produce anything and is billed
anyway; it is the easiest way to spend money on nothing in this pipeline.

---

## Step 7 — The fan-out

Only now. `submitShots` with the concurrency from the integration record.

**Should produce:** at most `concurrency` generations in flight at once, and one cost row
per submit.

**Then retry it immediately.** The second run must submit **nothing** — every idempotency
key already exists and the UNIQUE constraint refuses the insert, which the code treats as
"already submitted" rather than as an error. If the second run bills anything, rule 6 is
broken and every retry in the system is doubling costs.

---

## What closes the gate

All of:

- one clip generated, confirmed, and watched;
- the forgery check in step 4 refusing both cases;
- the failed-still check in step 6 producing no video charge;
- the re-run in step 7 billing nothing;
- `v_unconfirmed_terminal_generations` empty.

The last one should be empty at every point. A row in it is a generation whose outcome was
written without the vendor being asked — the shape of a forged callback landing.
