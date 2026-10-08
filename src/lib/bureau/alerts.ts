import type { Db } from '../db/server';
import { NOTIFY_FIELD, NOTIFY_INTEGRATION, sendNotification } from '../drivers/notify';
import { resolveCredentials } from '../integrations/credentials';

/**
 * Slack alerts, each one a `notifications` row whether or not it was delivered.
 *
 * The row is the point: a missed alert is something you can select (`delivered = false`,
 * `detail` says why), not a log line nobody opens. `dedupeKey` stops a repeating condition
 * (cap at 80%) from alerting every time the check runs.
 */

export type NotificationKind = 'briefs_pending' | 'cut_ready' | 'cap_80' | 'policy_flag' | 'qc_failed' | 'kill_switch' | 'info' | 'fallback';

export async function notify(
  db: Db,
  channelId: string,
  kind: NotificationKind,
  text: string,
  opts: { dedupeKey?: string; fetchImpl?: typeof fetch; webhookUrl?: string; episodeId?: string } = {},
): Promise<{ delivered: boolean; detail: string | null; duplicate: boolean }> {
  if (opts.dedupeKey) {
    const { data } = await db.from('notifications').select('id').eq('dedupe_key', opts.dedupeKey).maybeSingle();
    if (data) return { delivered: false, detail: 'already sent', duplicate: true };
  }
  let url = opts.webhookUrl;
  if (url === undefined) {
    const creds = await resolveCredentials(db, NOTIFY_INTEGRATION).catch(() => null);
    url = creds?.values[NOTIFY_FIELD];
  }
  // Named by the row's channel: with several channels a Slack line has to say whose it is.
  const { data: ch } = await db.from('channels').select('name').eq('id', channelId).maybeSingle();
  const sent = await sendNotification(url, `*Kiln · ${ch?.name ?? 'unknown channel'}* — ${text}`, opts.fetchImpl);
  const detail = sent.ok ? null : sent.detail;
  const row = { channel_id: channelId, kind, dedupe_key: opts.dedupeKey ?? null, text, delivered: sent.ok, detail };
  const { error } = await db.from('notifications').insert({ ...row, episode_id: opts.episodeId ?? null });
  // Before 0053 is pasted there is no episode_id column and no 'fallback' kind. The alert is
  // still written — as 'info', without the link — rather than lost: a lost alert is the exact
  // failure the notification centre exists to end.
  if (error && /episode_id|notifications_kind_check/.test(error.message)) {
    await db.from('notifications').insert({ ...row, kind: kind === 'fallback' ? 'info' : kind });
  }
  return { delivered: sent.ok, detail, duplicate: false };
}
