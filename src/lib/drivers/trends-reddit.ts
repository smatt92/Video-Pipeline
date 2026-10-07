import { z } from 'zod';

/**
 * Stage 1 — Reddit as a trend source, through the authenticated Data API.
 *
 * ── Why authenticated, and since when ────────────────────────────────────────
 *
 * Reddit stopped answering unauthenticated `/r/<sub>/hot.json` on 2026-05-28: every request
 * gets 403. The old fetch caught that per subreddit and returned an empty list, so hosted
 * `trend_signals` held 50 rows, every one from YouTube, and nothing on any screen said Reddit
 * had gone silent. So two things changed together: this driver uses OAuth, and every run
 * records each source's answer (trend_runs, 0049) so a refusal is a sentence on /trends.
 *
 * ── The credential ───────────────────────────────────────────────────────────
 *
 * An app of type "script" at reddit.com/prefs/apps gives a client id (under the app name)
 * and a secret. `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, set in Vercel production; the
 * Trigger deploy copies them to the worker (decision 0017). The token is the application-only
 * client-credentials grant: no Reddit username or password is stored.
 *
 * Reddit's free tier is for non-commercial use. Whether a monetised channel counts as
 * commercial is Reddit's terms to read and Sahil's call; /trends says so beside the source.
 *
 * ── Rule 5 ───────────────────────────────────────────────────────────────────
 *
 * Free within its rate limit (100 queries a minute per client id at the time of writing) —
 * no cost row, the same position as the YouTube Data API.
 */

const TIMEOUT_MS = 8_000;
const DEFAULT_AUTH_BASE = 'https://www.reddit.com';
const DEFAULT_API_BASE = 'https://oauth.reddit.com';
/** Reddit asks for a unique, descriptive User-Agent; generic ones are rate-limited first. */
export const REDDIT_USER_AGENT = 'server:kiln-trends:0.2 (by /u/kiln-bureau; +https://github.com/smatt92/video-pipeline)';

export interface RedditCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The task's one read of the credential. Trimmed; either half missing counts as unset. */
export function redditCredentialsFromEnv(
  id: string | undefined = process.env.REDDIT_CLIENT_ID,
  secret: string | undefined = process.env.REDDIT_CLIENT_SECRET,
): RedditCredentials | null {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export const REDDIT_NOT_CONFIGURED =
  'not configured: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not set — Reddit refuses unauthenticated reads ' +
  '(403 since 28-May-2026). Create a "script" app at reddit.com/prefs/apps, put its id and secret in Vercel ' +
  'production, then redeploy the worker.';

export interface RedditFetchOptions {
  /** Required, never read from the environment here — a harness must be able to pass null. */
  readonly credentials: RedditCredentials | null;
  /** Where the token comes from; a harness points it at a stub. */
  readonly authBaseUrl?: string;
  /** Where listings come from; a harness points it at a stub. */
  readonly apiBaseUrl?: string;
  readonly now?: number;
}

export interface RedditPost {
  readonly title: string;
  readonly score: number;
  readonly createdUtc: number;
  readonly raw: Record<string, unknown>;
}

export type RedditFetchResult =
  | { ok: true; posts: RedditPost[] }
  | { ok: false; posts: RedditPost[]; detail: string };

const Token = z.object({ access_token: z.string().min(1), token_type: z.string().optional(), expires_in: z.number().optional() });

const Listing = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: z.object({
          title: z.string(),
          score: z.number(),
          created_utc: z.number(),
          num_comments: z.number().optional(),
          subreddit: z.string().optional(),
          permalink: z.string().optional(),
        }),
      }),
    ),
  }),
});

async function timed(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** A refusal in words a person can act on. 403 is the one that matters. */
function refusal(status: number, where: string): string {
  if (status === 401) return `${where}: refused 401 — Reddit rejected REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET; re-copy them from reddit.com/prefs/apps.`;
  if (status === 403) return `${where}: refused 403 — needs an app (Reddit refuses reads that are not authenticated, or this app is not allowed this subreddit).`;
  if (status === 429) return `${where}: refused 429 — rate limited; the next scheduled run will try again.`;
  return `${where}: HTTP ${status}`;
}

/**
 * Hot posts from each subreddit, authenticated. One token per run. A subreddit that fails
 * ends the source's run with its reason and keeps what the earlier ones returned.
 */
export async function fetchRedditHot(subreddits: readonly string[], opts: RedditFetchOptions): Promise<RedditFetchResult> {
  if (!opts.credentials) return { ok: false, posts: [], detail: REDDIT_NOT_CONFIGURED };
  const authBase = opts.authBaseUrl ?? DEFAULT_AUTH_BASE;
  const apiBase = opts.apiBaseUrl ?? DEFAULT_API_BASE;
  const posts: RedditPost[] = [];

  let token: string;
  try {
    const basic = Buffer.from(`${opts.credentials.clientId}:${opts.credentials.clientSecret}`).toString('base64');
    const res = await timed(`${authBase}/api/v1/access_token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'user-agent': REDDIT_USER_AGENT, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return { ok: false, posts, detail: refusal(res.status, 'token') };
    const parsed = Token.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { ok: false, posts, detail: 'token: unexpected response shape — Reddit did not return an access_token' };
    token = parsed.data.access_token;
  } catch (err) {
    return { ok: false, posts, detail: `token: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (const sub of subreddits) {
    try {
      const res = await timed(`${apiBase}/r/${encodeURIComponent(sub)}/hot?limit=25&raw_json=1`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': REDDIT_USER_AGENT, accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, posts, detail: refusal(res.status, `r/${sub}`) };
      const parsed = Listing.safeParse(await res.json().catch(() => null));
      // One malformed subreddit is not a failed run, but it is said rather than skipped.
      if (!parsed.success) return { ok: false, posts, detail: `r/${sub}: unexpected response shape` };
      for (const c of parsed.data.data.children) {
        posts.push({ title: c.data.title, score: c.data.score, createdUtc: c.data.created_utc, raw: c.data });
      }
    } catch (err) {
      return { ok: false, posts, detail: `r/${sub}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, posts };
}
