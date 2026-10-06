/**
 * Outbound notifications. One vendor today (an incoming-webhook URL); callers above this
 * layer ask to "notify" and never name it.
 *
 * Notifications are best-effort by design: a failed ping returns a reason and never throws,
 * because a pipeline that fails a render because a chat message bounced has its priorities
 * backwards. The caller records the outcome in `notifications` so a missed alert is a row
 * somebody can select, not a log line nobody opens.
 */

export const NOTIFY_INTEGRATION = 'slack';
export const NOTIFY_FIELD = 'SLACK_WEBHOOK_URL';

export async function sendNotification(
  webhookUrl: string | undefined,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!webhookUrl) return { ok: false, detail: 'No notification webhook configured.' };
  if (!/^https:\/\//.test(webhookUrl)) return { ok: false, detail: 'Webhook URL is not https.' };

  // Incoming webhooks answer 200 with the literal body "ok", which is not JSON — so this
  // reads text rather than going through httpJson's parse.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe: posts one visible test line. There is no read-only call on a webhook URL. */
export async function probeNotify(webhookUrl: string | undefined) {
  const r = await sendNotification(webhookUrl, 'Kiln: notification channel connected.');
  return r.ok ? { passed: true, detail: 'Test message posted.' } : { passed: false, detail: r.detail };
}
