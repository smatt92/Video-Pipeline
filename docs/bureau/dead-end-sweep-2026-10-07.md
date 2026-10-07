# Dead-end sweep — src/app and src/components

Swept 07-Oct-2026: every `<a href>`, `<Link href>` and `<button>` (59 links, 52 buttons after fixes), plus `router.push`/`redirect()` targets. Internal targets were resolved against `src/app` with route groups `(app)`, `(setup)`, `(splash)`, `(onboarding)` stripped, dynamic segments matched, and `route.ts` handlers counted. Buttons were checked for an `onClick`, or `type=submit` (or default type) inside a `<form action>`.

## Dead ends found and fixed

| file:line | what | verdict | fix |
|---|---|---|---|
| src/lib/nav.ts — /concepts, /library/prompts, /library/voices, /library/music | sidebar items `blocked(...)`, rendering NotBuiltYet | dead end (disabled) | built all four; set `ready()` with a one-line reason each; removed the now-unused `blocked` helper |
| src/app/(app)/concepts/page.tsx, library/voices/page.tsx, library/music/page.tsx | `<NotBuiltYet>` placeholder pages | dead end | replaced with real screens |
| src/components/shell/not-built-yet.tsx | placeholder component, no caller left | orphan | deleted |
| src/app/(app)/concepts/[id]/page.tsx (old ~L186) | `<button type="button" disabled>Regenerate</button>` per shot, no handler ("inert until Gate 4") | dead button | removed; the footnote now links to /review and /bureau/cuts, where re-rolls are wired |
| src/app/(app)/concepts/[id]/page.tsx | showed any concept by id, any channel | wrong scope | `notFound()` unless the concept is on the active channel (`conceptOnChannel`) |
| src/app/(app)/board/page.tsx:98–115 (Row/RowShell) | every row linked to /concepts/[id], which now 404s for other channels | would-be dead link | `BoardRow.channelId` added (board.ts); rows of another channel render as a non-link with a "switch channel" title |
| src/components/pipeline/video-row.tsx:180, :192 | `Review` and `Resolve` `type=button` with no onClick | dead buttons | the component had no importer at all (fixture-era board row) — file deleted |
| src/app/(app)/concepts/[id]/page.tsx header | `₹0.00 across 0 generations` when no generation exists | absent shown as zero | now `— no generations yet` |

## Not clickable, on purpose

- Settings → Generation, Assembly, Publishing, Danger zone (`src/lib/settings/sections.ts`, `scaffolded`): rendered as disabled spans with phase + reason in the title, not links. No page exists for them; that is the design of that nav, unchanged.
- Library → Voices: "Change voice" and "Clear override" are hidden (not disabled) when `channel_voice_overrides` is missing; the page shows the 0046 sentence instead.
- Library → Music: Upload and Set default are hidden when 0046's tables are missing; Set default shows "no bed in this pool is uploaded yet" instead of a select when nothing is uploaded.
- Library → Prompts: Reinstate on a recipe with no watched sample requires a sample URL field (the server refuses without one, by name).
- Board rows of a channel other than the active one: not links (above).

## Full inventory — links

| file:line | target | verdict | fix |
|---|---|---|---|
| src/app/(app)/board/page.tsx:100 | `href={href}` → RowShell prop: /concepts/${row.id} (line 115) | ok | new wrapper; see line 115 |
| src/app/(app)/board/page.tsx:115 | `href={`/concepts/${row.id}`}` → src/app/(app)/concepts/[id]/page.tsx (via RowShell) | ok — a link only when the row is on the active channel | other-channel rows render as a non-link with a "switch channel" title, since /concepts/[id] now 404s across channels |
| src/app/(app)/board/page.tsx:276 | `href="/settings/integrations"` → src/app/(app)/settings/integrations/page.tsx | ok | — |
| src/app/(app)/board/page.tsx:406 | `href="/concepts"` → src/app/(app)/concepts/page.tsx | was a dead end (NotBuiltYet) | built: concepts list for the active channel |
| src/app/(app)/bureau/ready/page.tsx:47 | `href={b.download_urls.video}` → presigned bucket URL (external) | ok | — (file is do-not-touch) |
| src/app/(app)/bureau/ready/page.tsx:48 | `href={b.download_urls.captions_srt}` → presigned bucket URL (external) | ok | — (file is do-not-touch) |
| src/app/(app)/bureau/ready/page.tsx:49 | `href={b.download_urls.clean_master}` → presigned bucket URL (external) | ok | — (file is do-not-touch) |
| src/app/(app)/bureau/ready/page.tsx:58 | `href={d.captions_url}` → presigned bucket URL (external) | ok | — (file is do-not-touch) |
| src/app/(app)/bureau/ready/page.tsx:58 (second link) | `href={d.audio_url}` → presigned bucket URL (external) | ok | — (file is do-not-touch) |
| src/app/(app)/concepts/[id]/page.tsx:204 | `href="/review"` → src/app/(app)/review/page.tsx | ok | — |
| src/app/(app)/concepts/[id]/page.tsx:208 | `href="/bureau/cuts"` → src/app/(app)/bureau/cuts/page.tsx | ok | — |
| src/app/(app)/concepts/page.tsx:47 | `href={`/concepts/${r.id}`}` → src/app/(app)/concepts/[id]/page.tsx | ok (new) | — |
| src/app/(app)/concepts/page.tsx:66 | `href={r.episode.href}` → /bureau/cuts or /bureau/board — both exist; chosen by episode status | ok (new) | — |
| src/app/(app)/costs/page.tsx:416 | `href="/settings/rate-card"` → src/app/(app)/settings/rate-card/page.tsx | ok | — |
| src/app/(app)/review/[renderId]/page.tsx:91 | `href="/review"` → src/app/(app)/review/page.tsx | ok | — |
| src/app/(app)/review/page.tsx:115 | `href={`/review/${row.renderId}`}` → src/app/(app)/review/[renderId]/page.tsx | ok | — |
| src/app/(app)/settings/layout.tsx:52 | `href={`/settings/${s.slug}`}` → settings/{integrations,rate-card,guardrails,voice,mcp,supabase,workspace}/page.tsx | ok — only live sections are links | scaffolded sections (generation, assembly, publishing, danger) are disabled spans with their reason |
| src/app/(app)/studio/[sessionId]/page.tsx:79 | `href="/studio"` → src/app/(app)/studio/page.tsx | ok | — |
| src/app/(app)/studio/page.tsx:125 | `href={`/studio/${s.id}`}` → src/app/(app)/studio/[sessionId]/page.tsx | ok | — |
| src/app/(setup)/setup/[step]/page.tsx:95 | `href={`/setup/${s.slug}`}` → src/app/(setup)/setup/[step]/page.tsx | ok | — |
| src/app/(setup)/setup/[step]/page.tsx:250 | `href={`/setup/${prev.slug}`}` → src/app/(setup)/setup/[step]/page.tsx | ok | — |
| src/app/(setup)/setup/[step]/page.tsx:259 | `href={`/setup/${next.slug}`}` → src/app/(setup)/setup/[step]/page.tsx | ok | — |
| src/app/(splash)/about/page.tsx:69 | `href="/privacy"` → src/app/(splash)/privacy/page.tsx | ok | — |
| src/app/(splash)/about/page.tsx:79 | `href="/privacy"` → src/app/(splash)/privacy/page.tsx | ok | — |
| src/app/(splash)/about/page.tsx:84 | `href="/terms"` → src/app/(splash)/terms/page.tsx | ok | — |
| src/app/(splash)/about/page.tsx:89 | `href={LINKS.youtubeTerms}` → external URL | ok | — |
| src/app/(splash)/about/page.tsx:92 | `href={LINKS.apiServicesTerms}` → external URL | ok | — |
| src/app/(splash)/about/page.tsx:95 | `href={LINKS.googlePrivacy}` → external URL | ok | — |
| src/app/(splash)/about/page.tsx:102 | `href={`mailto:${CONTACT_EMAIL}`}` → mailto (external) | ok | — |
| src/app/(splash)/privacy/page.tsx:33 | `href={LINKS.youtubeTerms}` → external URL | ok | — |
| src/app/(splash)/privacy/page.tsx:34 | `href={LINKS.googlePrivacy}` → external URL | ok | — |
| src/app/(splash)/privacy/page.tsx:35 | `href={LINKS.apiServicesTerms}` → external URL | ok | — |
| src/app/(splash)/privacy/page.tsx:90 | `href={LINKS.userDataPolicy}` → external URL | ok | — |
| src/app/(splash)/privacy/page.tsx:98 | `href={LINKS.googlePermissions}` → external URL | ok | — |
| src/app/(splash)/privacy/page.tsx:103 | `href={`mailto:${CONTACT_EMAIL}`}` → mailto (external) | ok | — |
| src/app/(splash)/privacy/page.tsx:111 | `href={`mailto:${CONTACT_EMAIL}`}` → mailto (external) | ok | — |
| src/app/(splash)/terms/page.tsx:36 | `href={LINKS.youtubeTerms}` → external URL | ok | — |
| src/app/(splash)/terms/page.tsx:37 | `href={LINKS.apiServicesTerms}` → external URL | ok | — |
| src/app/(splash)/terms/page.tsx:38 | `href={LINKS.googlePrivacy}` → external URL | ok | — |
| src/app/(splash)/terms/page.tsx:39 | `href="/privacy"` → src/app/(splash)/privacy/page.tsx | ok | — |
| src/app/(splash)/terms/page.tsx:64 | `href={`mailto:${CONTACT_EMAIL}`}` → mailto (external) | ok | — |
| src/components/bureau/approval-card.tsx:119 | `href={brief.fact.source_url} target="_blank" rel="noreferrer"` → external URL | ok | — |
| src/components/bureau/bureau-nav.tsx:21 | `href={`/bureau/${slug}`}` → bureau/{approvals,cuts,ready,board,monitor,calendar,metrics,authorship}/page.tsx — all 8 exist | ok | — |
| src/components/bureau/bureau-nav.tsx:28 | `href="/costs"` → src/app/(app)/costs/page.tsx | ok | — |
| src/components/channels/channel-switcher.tsx:57 | `href="/channels/new"` → src/app/(app)/channels/new/page.tsx | ok | — |
| src/components/legal/legal-page.tsx:28 | `href={href}` → Ext: external URLs from LINKS / mailto | ok | — |
| src/components/legal/legal-page.tsx:49 | `href="/about"` → src/app/(splash)/about/page.tsx | ok | — |
| src/components/legal/legal-page.tsx:53 | `href="/privacy"` → src/app/(splash)/privacy/page.tsx | ok | — |
| src/components/legal/legal-page.tsx:56 | `href="/terms"` → src/app/(splash)/terms/page.tsx | ok | — |
| src/components/legal/legal-page.tsx:71 | `href={`mailto:${CONTACT_EMAIL}`}` → mailto (external) | ok | — |
| src/components/legal/legal-page.tsx:72 | `href="/privacy"` → src/app/(splash)/privacy/page.tsx | ok | — |
| src/components/legal/legal-page.tsx:73 | `href="/terms"` → src/app/(splash)/terms/page.tsx | ok | — |
| src/components/library/recipe-form.tsx:301 | `href={recipe.sampleOutputUrl}` → external URL | ok | — |
| src/components/onboarding/fork.tsx:60 | `href={signedIn ? '/setup' : '/login?next=/setup'}` → (setup)/setup/page.tsx and (setup)/login/page.tsx | ok | — |
| src/components/onboarding/fork.tsx:69 | `href={signedIn ? '/board' : '/login?next=/board'}` → (app)/board/page.tsx and (setup)/login/page.tsx | ok | — |
| src/components/onboarding/fork.tsx:115 | `href={href}` → prop: values at fork.tsx:60 and :69 | ok | — |
| src/components/onboarding/setup-checklist.tsx:64 | `href={`/setup/${step.slug}`}` → src/app/(setup)/setup/[step]/page.tsx | ok | — |
| src/components/shell/deferral-banner.tsx:68 | `href="/onboarding"` → src/app/(onboarding)/onboarding/page.tsx | ok | — |
| src/components/shell/sidebar.tsx:54 | `href={item.href}` → every NAV href in src/lib/nav.ts — all 22 have a page | ok — /concepts and /library/{prompts,voices,music} were disabled; now ready() | built the four screens |

## Full inventory — buttons

| file:line | wired by | verdict | fix |
|---|---|---|---|
| src/app/(setup)/login/sign-in-form.tsx:17 | type=submit inside <form action={…}> | ok | — |
| src/app/(setup)/login/sign-in-form.tsx:35 | type=submit inside <form action={…}> | ok | — |
| src/app/(setup)/oauth/authorize/consent.tsx:187 | type=submit inside <form action={…}> | ok | — |
| src/app/(setup)/oauth/authorize/consent.tsx:196 | type=submit inside <form action={…}> | ok | — |
| src/app/(setup)/setup/[step]/defer-form.tsx:105 | type=submit inside <form action={…}> | ok | — |
| src/app/(setup)/setup/[step]/defer-form.tsx:57 | type=submit inside <form action={…}> | ok | — |
| src/components/bureau/approval-card.tsx:129 | onClick handler | ok | — |
| src/components/bureau/approval-card.tsx:132 | onClick handler | ok | — |
| src/components/bureau/approval-card.tsx:95 | onClick handler | ok | — |
| src/components/bureau/csv-import.tsx:13 | default-type (submit) button inside <form action={…}> | ok | — |
| src/components/bureau/cut-controls.tsx:20 | onClick handler | ok | — |
| src/components/bureau/cut-controls.tsx:23 | onClick handler | ok | — |
| src/components/bureau/cut-controls.tsx:37 | onClick handler | ok | — |
| src/components/bureau/kill-switch.tsx:12 | onClick handler | ok | — |
| src/components/bureau/ready-controls.tsx:10 | onClick handler | ok | — |
| src/components/bureau/ready-controls.tsx:37 | onClick handler | ok | — |
| src/components/bureau/ready-controls.tsx:51 | onClick handler | ok | — |
| src/components/bureau/start-run.tsx:16 | onClick handler | ok | — |
| src/components/bureau/token-mint.tsx:23 | default-type (submit) button inside <form action={…}> | ok | — |
| src/components/bureau/token-mint.tsx:43 | onClick handler | ok | — |
| src/components/channels/add-channel-form.tsx:39 | type=submit inside <form action={…}> | ok | — |
| src/components/library/music-controls.tsx:61 | onClick handler | ok | — |
| src/components/library/music-controls.tsx:96 | type=submit inside <form action={…}> | ok | — |
| src/components/library/recipe-form.tsx:16 | type=submit inside <form action={…}> | ok | — |
| src/components/library/recipe-form.tsx:339 | type=submit inside <form action={…}> | ok | — |
| src/components/library/recipe-form.tsx:358 | type=submit inside <form action={…}> | ok | — |
| src/components/library/voice-controls.tsx:28 | type=submit inside <form action={…}> | ok | — |
| src/components/measure/snapshot-form.tsx:107 | type=submit inside <form action={…}> | ok | — |
| src/components/measure/snapshot-form.tsx:122 | onClick handler | ok | — |
| src/components/onboarding/setup-checklist.tsx:37 | onClick handler | ok | — |
| src/components/onboarding/step-forms.tsx:35 | type=submit inside <form action={…}> | ok | — |
| src/components/onboarding/tour-screen.tsx:120 | onClick handler | ok | — |
| src/components/onboarding/tour-screen.tsx:146 | onClick handler | ok | — |
| src/components/onboarding/tour-screen.tsx:166 | onClick handler | ok | — |
| src/components/onboarding/tour-screen.tsx:175 | onClick handler | ok | — |
| src/components/publish/publish-button.tsx:41 | onClick handler | ok | — |
| src/components/review/metadata-button.tsx:47 | onClick handler | ok | — |
| src/components/review/regenerate-dialog.tsx:205 | onClick handler | ok | — |
| src/components/review/screen.tsx:400 | onClick handler | ok | — |
| src/components/review/screen.tsx:520 | onClick handler | ok | — |
| src/components/review/screen.tsx:529 | onClick handler | ok | — |
| src/components/review/screen.tsx:549 | onClick handler | ok | — |
| src/components/review/shot-strip.tsx:104 | onClick handler | ok | — |
| src/components/review/shot-strip.tsx:274 | onClick handler | ok | — |
| src/components/settings/credits-and-concurrency.tsx:23 | type=submit inside <form action={…}> | ok | — |
| src/components/settings/host-voice-control.tsx:65 | onClick handler | ok | — |
| src/components/settings/integration-card.tsx:45 | type=submit inside <form action={…}> | ok | — |
| src/components/settings/rate-row.tsx:146 | onClick handler | ok | — |
| src/components/settings/rate-row.tsx:98 | onClick handler | ok | — |
| src/components/settings/ui-scale-control.tsx:59 | onClick handler | ok | — |
| src/components/studio/forms.tsx:28 | type=submit inside <form action={…}> | ok | — |
| src/components/trends/run-now.tsx:18 | onClick handler | ok | — |

## Programmatic navigation

| file:line | target | verdict |
|---|---|---|
| src/components/shell/command-palette.tsx:85 | router.push('/onboarding') | ok |
| src/components/shell/command-palette.tsx:99 | router.push('/setup') | ok |
| src/components/shell/command-palette.tsx:163 | router.push(item.href) — NAV items, all ready and routed | ok |
| src/components/studio/forms.tsx:54 | router.push(`/studio/${id}`) | ok |
| src/app/(app)/settings/page.tsx:4 | redirect('/settings/integrations') | ok |
| src/app/(app)/bureau/page.tsx:5 | redirect('/bureau/approvals') | ok |
| src/app/(setup)/setup/page.tsx:23 | redirect(`/setup/${slug}`) | ok |
| src/app/(setup)/auth/callback/route.ts, login/actions.ts, oauth/authorize/* | redirect to sanitised `next` / OAuth URLs | ok (not changed) |
