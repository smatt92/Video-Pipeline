-- 0053 — The notification centre, and the fallback alert.
--
-- Forward-only. One CHECK widened, two columns added, nothing rewritten.
--
-- Every alert Kiln ever raised was already a row (0037) — and every one of them said
-- delivered = false, "No notification webhook configured.", because Slack was never set up and
-- no screen read the table. The rows were the instrument for silence, and nothing read them
-- (Sahil, 08-Oct: "no notifications received for fallback … no notification centre").
--
-- read_at:    when the approver saw it in the centre. NULL = unread, never "unknown".
-- episode_id: the episode an alert is about, so the centre can link to it and, for a format
--             fallback, offer the decision in place. NULL for channel-wide alerts (cap at 80%).
-- 'fallback': Kiln made something cheaper or lower than what was picked — a format it could
--             not make, clips swapped to stills, pictures that became diagrams, a voice on the
--             second model. Each one is now said, and a format fallback is asked, not taken.

alter table notifications
  add column read_at    timestamptz,
  add column episode_id uuid references episodes(id) on delete set null;

alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in
  ('briefs_pending','cut_ready','cap_80','policy_flag','qc_failed','kill_switch','info','fallback'));

create index if not exists notifications_unread on notifications (channel_id, created_at desc) where read_at is null;
