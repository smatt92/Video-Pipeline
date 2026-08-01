-- Local development convenience. Applied by `supabase db reset`; never runs against
-- production, and after migration 0014 nothing the application requires lives here.
--
-- That distinction is the point, and it was learned the hard way: `supabase db push`
-- applies migrations and not this file, so the `integrations` and `driver_health` rows that
-- used to sit here were absent on a freshly pushed database — and the onboarding actions
-- look an integration up by slug and throw when it is missing. Three wizard steps could not
-- be walked at all. 0014 moved every row the app requires into a migration, and
-- `pnpm check:catalog` now fails if a new driver is added to the catalogue without one.
--
-- The test for anything added below: if the application throws, blocks or renders wrongly
-- without this row on a fresh production database, it does not belong in this file.

-- The one survivor, and it passes that test: onboarding step 8 creates a real channel
-- itself, so production never needs this. It exists so a local developer can insert a
-- concept by hand — `concepts.channel_id` is NOT NULL — without walking the wizard first.

insert into channels (id, name, platform, niche, handle, is_active)
values (
  '00000000-0000-4000-8000-000000000001',
  'Kiln — dev channel',
  'youtube',
  'unset',
  null,
  true
)
on conflict (id) do nothing;
