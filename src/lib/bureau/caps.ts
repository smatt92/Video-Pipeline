import type { Db } from '../db/server';

/**
 * Spend headroom against the channel's daily and monthly caps (channel_policy, via
 * v_channel_spend). Long-form jobs get the long-form daily cap (₹1,500) instead of the
 * Shorts' ₹600. Figures are rate-card estimates — the same ones the ledger sums.
 *
 * `null` headroom means the spend could not be read: the dispatcher treats that as NO
 * headroom. A cap you cannot check is a cap you cannot honour, so it refuses rather than
 * spends on an unknown.
 */
export interface Headroom {
  dailyInr: number | null;
  monthlyInr: number | null;
  todayInr: number | null;
  monthInr: number | null;
  dailyCapInr: number | null;
  monthlyCapInr: number | null;
}

export async function headroom(db: Db, channelId: string, kind: 'short' | 'long_form' = 'short'): Promise<Headroom> {
  const { data } = await db.from('v_channel_spend').select('*').eq('channel_id', channelId).maybeSingle();
  if (!data) return { dailyInr: null, monthlyInr: null, todayInr: null, monthInr: null, dailyCapInr: null, monthlyCapInr: null };
  const today = Number(data.today_inr);
  const month = Number(data.month_inr);
  const dailyCap = Number(kind === 'long_form' ? data.daily_longform_cap_inr : data.daily_cap_inr);
  const monthlyCap = Number(data.monthly_cap_effective_inr);
  return { dailyInr: dailyCap - today, monthlyInr: monthlyCap - month, todayInr: today, monthInr: month, dailyCapInr: dailyCap, monthlyCapInr: monthlyCap };
}

export function fits(h: Headroom, costInr: number): boolean {
  if (h.dailyInr === null || h.monthlyInr === null) return false;
  return costInr <= h.dailyInr && costInr <= h.monthlyInr;
}

/** Midnight in Asia/Kolkata after `now`, as an ISO instant: when the daily cap resets. */
export function nextIstMidnight(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 330 * 60_000;
  return new Date(next).toISOString();
}

/** The two 80% alerts, each once per day / month (dedupe keys). */
export function capAlerts(h: Headroom, now: Date): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  if (h.todayInr !== null && h.dailyCapInr && h.todayInr >= 0.8 * h.dailyCapInr) {
    out.push({ key: `cap80:day:${day}`, text: `Today’s spend is ₹${h.todayInr.toFixed(0)} of the ₹${h.dailyCapInr.toFixed(0)} daily cap (${Math.round((100 * h.todayInr) / h.dailyCapInr)}%, estimate). Raise the cap on Costs, or the rest waits for tomorrow.` });
  }
  if (h.monthInr !== null && h.monthlyCapInr && h.monthInr >= 0.8 * h.monthlyCapInr) {
    out.push({ key: `cap80:month:${day.slice(0, 7)}`, text: `This month’s spend is ₹${h.monthInr.toFixed(0)} of the ₹${h.monthlyCapInr.toFixed(0)} monthly cap (${Math.round((100 * h.monthInr) / h.monthlyCapInr)}%, estimate). Raise the cap on Costs, or hold the next briefs.` });
  }
  return out;
}
