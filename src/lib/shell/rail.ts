import 'server-only';

import { FORMAT_FALLBACK_PREFIX } from '../bureau/fallbacks';
import { RUNNING } from '../bureau/running';
import { glowFrom, type Glow } from './glow';
import { routeClient } from '../auth/supabase';
import { readSetupProgress } from '../onboarding/progress';
import { currentChannel } from '../channels/active';
import type { ChannelSummary } from '../channels/list';
import { serverClient } from '../db/server';
import { initials } from './initials';

/**
 * Everything the Rail, the tab bar and the ⌘K palette show, read once per request in the app
 * layout. Every count is a row count for the active channel — no badge is decorative — and a
 * count that could not be read is `null`, which the rail renders as no badge rather than a 0.
 */

export interface RailChannel {
  id: string;
  name: string;
  handle: string | null;
  initials: string;
  hasBible: boolean;
}

export interface RailSlot {
  episodeId: string;
  slot: string;
  title: string;
  status: string;
}

export interface RailData {
  channels: RailChannel[];
  activeId: string | null;
  counts: {
    approvals: number | null;
    cuts: number | null;
    blocked: number | null;
    ready: number | null;
    genFailed: number | null;
    /** Unread alerts (0053). null before 0053 is pasted: cannot be counted, so no badge. */
    unread: number | null;
  };
  /** Kill switch for the active channel. null = no policy row (or not readable). */
  kill: { on: boolean; reason: string | null } | null;
  user: { name: string; initials: string } | null;
  slots: RailSlot[];
  pendingBriefs: { id: string; slot: string | null; premise: string }[];
  /** Studio setup, while unfinished. null once finished or when it cannot be read. */
  setup: { done: number; total: number } | null;
  /**
   * The ambient glow (Kiln Glass: glow is information), derived from rows, never decorative.
   * `alert` — an unread fallback or qc_failed alert, or a halted episode; `generating` — any
   * episode in a running status; otherwise `idle`. Alert wins: it is the one that needs you.
   */
  glow: Glow;
}

function toRailChannel(c: ChannelSummary): RailChannel {
  return { id: c.id, name: c.name, handle: c.handle, initials: initials(c.name), hasBible: c.hasBible };
}

/** `count: 'exact', head: true` returns `count` as a number; a failed read is null, not 0. */
async function countOf(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await q;
    return error ? null : count;
  } catch {
    return null;
  }
}

export async function railData(): Promise<RailData> {
  const empty: RailData = {
    channels: [],
    activeId: null,
    counts: { approvals: null, cuts: null, blocked: null, ready: null, genFailed: null, unread: null },
    kill: null,
    user: null,
    slots: [],
    pendingBriefs: [],
    setup: null,
    glow: 'idle',
  };

  let active: ChannelSummary | null = null;
  try {
    const cur = await currentChannel();
    active = cur.active;
    empty.channels = cur.all.map(toRailChannel);
    empty.activeId = active?.id ?? null;
  } catch {
    return empty;
  }

  const db = serverClient();

  const setupP = readSetupProgress()
    .then((p) => (p && !p.finished ? { done: p.completed.length, total: p.total } : null))
    .catch(() => null);

  const userP = (async () => {
    try {
      const supabase = await routeClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data } = await db.from('profiles').select('display_name, email').eq('id', user.id).maybeSingle();
      const name = data?.display_name?.trim() || (user.email ?? '').split('@')[0] || 'You';
      return { name, initials: initials(name) };
    } catch {
      return null;
    }
  })();

  if (!active) return { ...empty, user: await userP, setup: await setupP };
  const ch = active.id;

  const [briefsPending, fallbacks, unread, cuts, blocked, ready, genFailed, kill, slots, briefs, user, setup, running, halted, alarms] = await Promise.all([
    countOf(db.from('briefs').select('id', { count: 'exact', head: true }).eq('channel_id', ch).eq('status', 'pending')),
    // A format fallback waiting on the approver is an approval too (fallbacks.ts), so it counts on the badge.
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).eq('status', 'halted').like('status_detail', `${FORMAT_FALLBACK_PREFIX}%`)),
    countOf(db.from('notifications').select('id', { count: 'exact', head: true }).eq('channel_id', ch).is('read_at', null)),
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).eq('status', 'awaiting_cut')),
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).in('status', ['failed', 'halted'])),
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).eq('status', 'bundled')),
    countOf(
      db
        .from('gen_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('updated_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    ),
    (async () => {
      try {
        const { data } = await db.from('channel_policy').select('kill_switch, kill_switch_reason').eq('channel_id', ch).maybeSingle();
        return data ? { on: !!data.kill_switch, reason: data.kill_switch_reason } : null;
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        const { data: eps } = await db
          .from('episodes')
          .select('id, slot_id, status, brief_id')
          .eq('channel_id', ch)
          .order('updated_at', { ascending: false })
          .limit(30);
        const ids = (eps ?? []).map((e) => e.brief_id);
        const prem = new Map<string, string>();
        if (ids.length) {
          const { data: bs } = await db.from('briefs').select('id, premise').in('id', ids);
          for (const b of bs ?? []) prem.set(b.id, b.premise);
        }
        return (eps ?? []).map((e) => ({ episodeId: e.id, slot: e.slot_id ?? 'bank', title: prem.get(e.brief_id) ?? '', status: e.status }));
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const { data } = await db.from('briefs').select('id, slot_id, premise').eq('channel_id', ch).eq('status', 'pending').order('created_at').limit(10);
        return (data ?? []).map((b) => ({ id: b.id, slot: b.slot_id, premise: b.premise }));
      } catch {
        return [];
      }
    })(),
    userP,
    setupP,
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).in('status', [...RUNNING])),
    countOf(db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', ch).eq('status', 'halted')),
    // read_at arrives with 0053; before it, this errors → null → no alert from it (never a guess).
    countOf(db.from('notifications').select('id', { count: 'exact', head: true }).eq('channel_id', ch).in('kind', ['fallback', 'qc_failed']).is('read_at', null)),
  ]);

  const approvals = briefsPending === null ? null : briefsPending + (fallbacks ?? 0);
  return {
    ...empty,
    counts: { approvals, cuts, blocked, ready, genFailed, unread },
    kill,
    slots,
    pendingBriefs: briefs,
    user,
    setup,
    glow: glowFrom({ running, halted, unreadAlarms: alarms }),
  };
}
