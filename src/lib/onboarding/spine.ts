import 'server-only';

import { bibleOrNull, currentChannel } from '../channels/active';
import type { ChannelSummary } from '../channels/list';
import { serverClient } from '../db/server';
import { voicesScreen } from '../library/voices';
import { todayIn } from '../screens/common';
import { onboardingProgress, type OnboardingProgress } from './progress';
import { SETUP_PAGES, type SetupPage } from './pages';

/**
 * The progress spine (canvas: OnbSpine): for every setup page, done / current / to do / skipped
 * / locked, and — the point of it — what still blocks the first video, one sentence each.
 *
 * Studio pages read the wizard's own ticks (`onboarding_completed_steps`) and deferrals, so
 * the spine and the wizard cannot disagree. Channel pages read the active channel's rows:
 * the cast is done when every character routes to a voice (`voicesScreen`, the voice stage's
 * own predicate), the schedule when a slot lies ahead, the caps when the policy row carries
 * a daily and a per-Short cap. Nothing is stored for them — a tick that could go stale is
 * exactly what a channel page must not have.
 */

export type PageState = 'done' | 'cur' | 'todo' | 'skip' | 'lock';

export interface SpineItem {
  page: SetupPage;
  state: PageState;
  /** Shown under the label. */
  sub: string;
  /** Present while the page blocks the first video. */
  blocks: string | null;
}

export interface Spine {
  items: SpineItem[];
  blockers: { text: string; slug: string }[];
  doneCount: number;
  resume: SetupPage;
  channel: ChannelSummary | null;
  progress: OnboardingProgress;
  /** Cast detail for the cast page's own sentence. */
  unlockedCast: string[];
}

export async function readSpine(current?: string): Promise<Spine> {
  const progress = await onboardingProgress();
  const db = serverClient();
  const { active } = await currentChannel().catch(() => ({ active: null as ChannelSummary | null }));
  const bible = active ? bibleOrNull(active) : null;

  // Channel facts, each read on its own so one failing read leaves the others standing.
  const [castState, slotAhead, capsSet] = await Promise.all([
    (async () => {
      if (!active || !bible) return { done: false, unlocked: [] as string[] };
      try {
        const v = await voicesScreen(db, active.id, bible);
        const unlocked = v.rows.filter((r) => !r.route.ok).map((r) => r.name);
        return { done: unlocked.length === 0 && v.rows.length > 0, unlocked };
      } catch {
        return { done: false, unlocked: [] as string[] };
      }
    })(),
    (async () => {
      if (!active) return false;
      const { count } = await db.from('slots').select('id', { count: 'exact', head: true }).eq('channel_id', active.id).gte('slot_date', todayIn('Asia/Kolkata'));
      return (count ?? 0) > 0;
    })().catch(() => false),
    (async () => {
      if (!active) return false;
      const { data } = await db.from('channel_policy').select('daily_cap_inr, per_short_cap_inr').eq('channel_id', active.id).maybeSingle();
      return !!data && data.daily_cap_inr !== null && data.per_short_cap_inr !== null;
    })().catch(() => false),
  ]);

  const done = new Set(progress.completed);
  const deferred = new Set(progress.deferred.map((d) => d.step));

  const isDone = (p: SetupPage): boolean => {
    switch (p.slug) {
      case 'basics':
        return done.has(8) || !!active;
      case 'cast':
        return castState.done;
      case 'schedule':
        return slotAhead;
      case 'caps':
        return capsSet;
      case 'connections':
        return done.has(9);
      case 'finish':
        return false;
      default:
        return p.steps.every((s) => done.has(s));
    }
  };

  const required = SETUP_PAGES.filter((p) => !p.optional && p.slug !== 'finish');
  const firstOpen = required.find((p) => !isDone(p)) ?? SETUP_PAGES.find((p) => p.slug === 'finish')!;

  const items: SpineItem[] = SETUP_PAGES.map((p) => {
    const d = isDone(p);
    let state: PageState = d ? 'done' : 'todo';
    if (p.slug === 'connections' && !d && (deferred.has(9) || firstOpen.n > p.n)) state = 'skip';
    if (p.slug === 'finish' && required.some((r) => !isDone(r))) state = 'lock';
    if (current === p.slug) state = 'cur';
    const sub =
      state === 'skip'
        ? 'Skipped — add later in Settings'
        : state === 'lock'
          ? 'Opens when nothing blocks it'
          : p.slug === 'cast' && castState.unlocked.length
            ? `${castState.unlocked.length} voice${castState.unlocked.length === 1 ? '' : 's'} not locked`
            : p.optional
              ? `Optional · ${p.sub}`
              : p.sub;
    return { page: p, state, sub, blocks: !d && p.blocks ? p.blocks : null };
  });

  return {
    items,
    blockers: items.filter((i) => i.blocks).map((i) => ({ text: i.blocks!, slug: i.page.slug })),
    doneCount: items.filter((i) => isDone(i.page)).length,
    resume: firstOpen,
    channel: active,
    progress,
    unlockedCast: castState.unlocked,
  };
}
