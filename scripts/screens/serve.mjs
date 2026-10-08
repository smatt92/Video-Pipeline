#!/usr/bin/env node
/**
 * A local stand-in for the hosted Supabase project, so the app's screens can be opened and
 * measured in a container that cannot reach `*.supabase.co` (CLAUDE.md: the egress policy
 * refuses it) and has no Docker daemon for `supabase start`.
 *
 *   /rest/v1/*      → PostgREST over the local Postgres (the real query layer the app uses)
 *   /auth/v1/user   → one fixed signed-in user (the allowlisted address you pass)
 *   anything else   → 404, said in the body
 *
 * `--delay=MS` adds that many milliseconds to every REST request. Seoul↔Seoul (icn1 ↔
 * ap-northeast-2) is a few ms of network plus PostgREST's own time, so the default 0 under-
 * states production slightly; a large value (2000) holds every screen in its loading state long
 * enough to photograph the skeleton.
 *
 * Usage (DATABASE_URL a local Postgres with migrations + supabase/seed.sql + scripts/screens/seed.sql):
 *   node scripts/screens/serve.mjs --postgrest=/tmp/postgrest --email=you@example.com [--delay=0]
 * then `next start` with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 and the cookie that
 * `--print-cookie` prints. Development aid only: nothing in src/ or CI depends on it.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const DB = process.env.DATABASE_URL;
const EMAIL = arg('email', 'owner@example.com');
let DELAY = Number(arg('delay', '0'));
const PORT = Number(arg('port', '54321'));
const PGRST = arg('postgrest', 'postgrest');
const USER_ID = arg('user', 'a0000000-0000-4000-8000-0000000000aa');
if (!DB) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

export const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: 'local', refresh_token: 'local', token_type: 'bearer', expires_in: 10 * 365 * 86400, expires_at: Math.floor(Date.now() / 1000) + 10 * 365 * 86400, user };
const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
if (process.argv.includes('--print-cookie')) {
  console.log(cookie);
  process.exit(0);
}

const conf = join(tmpdir(), 'kiln-postgrest.conf');
writeFileSync(conf, [`db-uri = "${DB}"`, 'db-schemas = "public"', 'db-anon-role = "postgres"', 'server-port = 54320', 'server-host = "127.0.0.1"', 'db-max-rows = 5000', 'log-level = "error"'].join('\n'));
const pg = spawn(PGRST, [conf], { stdio: 'inherit' });
pg.on('exit', (c) => {
  console.error(`postgrest exited ${c}`);
  process.exit(1);
});

let n = 0;
let TRACE = false;
let t0 = Date.now();
let a = 0;
http
  .createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/auth/v1/user')) {
      a++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(user));
    }
    if (url.startsWith('/__delay/')) {
      // Change the REST delay without a restart: /__delay/2000 to photograph skeletons, /__delay/0 after.
      DELAY = Number(url.slice('/__delay/'.length)) || 0;
      res.writeHead(200);
      return res.end(String(DELAY));
    }
    if (url.startsWith('/__trace/')) {
      // /__trace/on logs every REST request with its offset from this call: the waves a page makes.
      TRACE = url.endsWith('/on');
      t0 = Date.now();
      res.writeHead(200);
      return res.end(String(TRACE));
    }
    if (url === '/__count') {
      // REST requests since the last read, then reset: a measurement aid (per-page request counts).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rest: n, auth: a }));
      n = 0;
      a = 0;
      return;
    }
    if (!url.startsWith('/rest/v1')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`screens/serve: no stand-in for ${url}`);
    }
    n++;
    if (TRACE) console.log(`${String(Date.now() - t0).padStart(6)} ms  ${req.method} ${decodeURIComponent(url.slice('/rest/v1'.length)).slice(0, 140)}`);
    const headers = { ...req.headers, host: '127.0.0.1:54320' };
    delete headers.authorization; // PostgREST runs everything as the anon role (local superuser)
    const forward = () => {
      const up = http.request({ host: '127.0.0.1', port: 54320, path: url.slice('/rest/v1'.length) || '/', method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      req.pipe(up);
    };
    if (DELAY > 0) setTimeout(forward, DELAY);
    else forward();
  })
  .listen(PORT, '127.0.0.1', () => console.log(`screens/serve on :${PORT} (REST delay ${DELAY} ms)`));

setInterval(() => {
  if (n) console.log(`REST requests so far: ${n}`);
}, 60_000).unref();
