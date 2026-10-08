import type { Db } from '../db/server';
import { awaitingFallback, fallbackReason } from '../bureau/fallbacks';

/**
 * The notification centre's reads (0053). Every alert Kiln raises is a `notifications` row
 * whether or not Slack delivered it; this is the screen that reads them back.
 *
 * `read_at` arrives with 0053. Before it is pasted the centre still lists every row, and the
 * unread count is null — "cannot be counted", shown as no badge — never a count of every row
 * ever written, which would be a number about nothing. The probe is the query itself: the
 * column's absence is the error, so the badge turns itself on the moment the bundle lands.
 */

export interface NotificationRow {
  id: string;
  kind: string;
  text: string;
  delivered: boolean;
  detail: string | null;
  createdAt: string;
  /** null = unread; undefined = this database cannot say (0053 not pasted). */
  readAt: string | null | undefined;
  episodeId: string | null;
}

export interface FallbackWaiting {
  episodeId: string;
  reason: string;
  premise: string | null;
  slotId: string | null;
  updatedAt: string;
}

type Raw = { id: string; kind: string; text: string; delivered: boolean; detail: string | null; created_at: string; read_at?: string | null; episode_id?: string | null };

export async function listNotifications(db: Db, channelId: string, limit = 100): Promise<{ rows: NotificationRow[]; readable: boolean }> {
  const full = await db.from('notifications').select('id, kind, text, delivered, detail, created_at, read_at, episode_id').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(limit);
  let data = full.data as Raw[] | null;
  let readable = !full.error;
  if (full.error) {
    const legacy = await db.from('notifications').select('id, kind, text, delivered, detail, created_at').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(limit);
    if (legacy.error) throw new Error(`notifications could not be read: ${legacy.error.message}`);
    data = legacy.data as Raw[];
    readable = false;
  }
  return {
    readable,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      delivered: r.delivered,
      detail: r.detail,
      createdAt: r.created_at,
      readAt: readable ? (r.read_at ?? null) : undefined,
      episodeId: r.episode_id ?? null,
    })),
  };
}

/** Unread alerts for the rail's badge. null when it cannot be counted (0053 not pasted, or the read failed). */
export async function unreadCount(db: Db, channelId: string): Promise<number | null> {
  const { count, error } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).is('read_at', null);
  return error ? null : (count ?? 0);
}

export async function markAllRead(db: Db, channelId: string): Promise<{ ok: boolean; detail: string | null }> {
  const { error } = await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('channel_id', channelId).is('read_at', null);
  return error ? { ok: false, detail: error.message } : { ok: true, detail: null };
}

/**
 * Episodes halted waiting on a format-fallback decision (fallbacks.ts). Read from the episode
 * row, not from the notification: the decision is still open exactly while the episode says
 * so, however many alerts were or were not written about it.
 */
export async function fallbacksWaiting(db: Db, channelId: string): Promise<FallbackWaiting[]> {
  const { data, error } = await db.from('episodes').select('id, status, status_detail, slot_id, brief_id, updated_at').eq('channel_id', channelId).eq('status', 'halted');
  if (error) throw new Error(`episodes could not be read: ${error.message}`);
  const waiting = (data ?? []).filter((e) => awaitingFallback(e.status, e.status_detail));
  if (!waiting.length) return [];
  const { data: briefs } = await db.from('briefs').select('id, premise').in('id', waiting.map((e) => e.brief_id));
  const premise = new Map((briefs ?? []).map((b) => [b.id, b.premise as string | null]));
  return waiting.map((e) => ({ episodeId: e.id, reason: fallbackReason(e.status_detail), premise: premise.get(e.brief_id) ?? null, slotId: e.slot_id, updatedAt: e.updated_at }));
}
