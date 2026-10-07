/**
 * When stage 1 collects on its own — one definition, read by the Trigger schedule
 * (`01-trends.ts`, which builds its cron from these) and by /trends ("next collection"), so the
 * screen cannot promise a time the schedule does not keep.
 *
 * 00:40, 06:40, 12:40 and 18:40 UTC = 06:10, 12:10, 18:10 and 00:10 IST. Written in UTC:
 * Trigger.dev's deploy rejected the zone name 'Asia/Kolkata' ("Invalid IANA timezone"), and
 * India has no daylight saving, so UTC+05:30 is exact all year. Minute 40 so this does not queue
 * behind every job on the hour, and so the 06:10 IST run lands before 19-draft-briefs (06:45 IST).
 */
export const TRENDS_HOURS_UTC = [0, 6, 12, 18] as const;
export const TRENDS_MINUTE = 40;
export const TRENDS_CRON = `${TRENDS_MINUTE} ${TRENDS_HOURS_UTC.join(',')} * * *`;

/** The next scheduled collection strictly after `now`. */
export function nextTrendsCollection(now: number = Date.now()): Date {
  const d = new Date(now);
  for (let day = 0; day < 2; day++) {
    for (const h of TRENDS_HOURS_UTC) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + day, h, TRENDS_MINUTE);
      if (t > now) return new Date(t);
    }
  }
  /* c8 ignore next — two days always contain a slot */
  return new Date(now + 6 * 3_600_000);
}

/** "18:10 IST, 7 Oct" — India has no DST, so the offset is fixed. */
export function istLabel(at: Date | string): string {
  const d = new Date(new Date(at).getTime() + 5.5 * 3_600_000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST, ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
