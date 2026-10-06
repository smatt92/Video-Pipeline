#!/usr/bin/env node
/**
 * What a stranger can reach, on the production server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   /about, /privacy and /terms render signed out (200), with what Google's consent screen and
 *   the YouTube API audit look for: the app's name, the channel, the two scopes, the contact
 *   address, links to each other, the YouTube Terms, the YouTube API Services Terms and the
 *   Google Privacy Policy, and the Limited Use statement.
 *
 *   Every other page in the app still redirects a signed-out request to /login. Routes are
 *   ENUMERATED from src/app rather than listed here, so a page added tomorrow is covered
 *   without anyone remembering this file; the public set is the one list kept by hand, and it
 *   is the same list as middleware's.
 *
 *   The OAuth consent screen is NOT public, and its query string survives the trip through
 *   /login. The OAuth discovery documents and the 401 on /api/mcp are public and answer
 *   through the real Next route handlers (verify:oauth drives the logic; this drives the
 *   adapters).
 *
 *   /setup is never a 404: signed out it redirects to /login like the rest of the app (the
 *   slug it resolves to when signed in is checked for every state by test:entry).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Anything signed in: the server's Supabase URL is unreachable on purpose. And that Google's
 *   reviewers accept the wording — only the audit can say that.
 *
 * Usage: node scripts/verify-public.mjs [port]   (after `pnpm build`)
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PORT = Number(process.argv[2] ?? 3112);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond, label, detail = '') => {
  console[cond ? 'log' : 'error'](`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// Same environment as verify:tour: enough for `next start` to boot, every service unreachable.
const ENV = {
  ...process.env,
  APP_URL: BASE,
  WEBHOOK_CALLBACK_BASE_URL: 'https://ci.invalid',
  ALLOWED_EMAIL: 'ci@ci.invalid',
  NEXT_PUBLIC_SUPABASE_URL: 'https://ci.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci',
  SUPABASE_SERVICE_ROLE_KEY: 'ci',
  STORAGE_DRIVER: 'supabase-storage',
  SUPABASE_STORAGE_BUCKET: 'ci',
  SUPABASE_S3_ACCESS_KEY_ID: 'ci',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'ci',
  SUPABASE_S3_REGION: 'us-east-1',
  TRIGGER_PROJECT_REF: 'proj_ci',
  TRIGGER_SECRET_KEY: 'tr_ci',
  ANTHROPIC_API_KEY: 'ci',
  VIDEO_DRIVER: 'none',
};

/** Must equal middleware's PUBLIC_PATHS minus framework internals. */
const PUBLIC_PREFIXES = ['/', '/onboarding', '/login', '/auth', '/api/webhooks', '/api/mcp', '/api/oauth', '/.well-known', '/privacy', '/terms', '/about'];
const isPublic = (path) => PUBLIC_PREFIXES.some((p) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`)));

// ── Enumerate every page from the filesystem ────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'page.tsx' || name === 'route.ts') out.push(full);
  }
  return out;
}
function urlFor(file) {
  const segs = relative('src/app', file).split(sep).slice(0, -1);
  const parts = segs
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (/^\[\[\.\.\..+\]\]$/.test(s) ? null : /^\[\.\.\..+\]$/.test(s) ? 'x' : /^\[.+\]$/.test(s) ? '00000000-0000-4000-8000-000000000000' : s))
    .filter((s) => s !== null);
  return `/${parts.join('/')}`;
}
const files = walk('src/app');
const pages = files.filter((f) => f.endsWith('page.tsx')).map((f) => ({ file: f, path: urlFor(f) }));

let server;
async function start() {
  // Something already answering on the port would be measured instead of this build — which
  // is exactly what happened while this harness was written: a server left over from an
  // earlier run (npx's child outlives a kill of npx) answered with the previous build, and
  // three checks failed against code that had already been fixed. Refuse rather than measure
  // a stranger.
  const occupied = await fetch(`${BASE}/about`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (occupied) {
    console.error(`\nSomething is already listening on ${BASE}. Stop it, or pass another port.\n`);
    process.exit(2);
  }
  // Its own process group, so the exit handler can stop next-server and not only npx.
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log = [];
  server.stdout.on('data', (d) => log.push(d.toString()));
  server.stderr.on('data', (d) => log.push(d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/about`, { signal: AbortSignal.timeout(2000) });
      if (r.status > 0) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not answer on ${BASE} in 30s:\n${log.join('')}`);
}
process.on('exit', () => {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
});

try {
  readFileSync('.next/BUILD_ID', 'utf8');
} catch {
  console.error('\nNo build. Run `pnpm build` first.\n');
  process.exit(2);
}

const get = (path, init = {}) => fetch(`${BASE}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });

console.log('\nPublic surface, signed out, on the production server\n');
await start();

try {
  console.log('1. The legal pages render for a stranger\n');
  const must = {
    '/about': ['Kiln', '@BureauofReality', 'youtube.upload', 'yt-analytics.readonly', 'sahil.matt@gmail.com',
      'href="/privacy"', 'href="/terms"', 'YouTube API Services Terms of Service', 'Google Privacy Policy',
      'policies.google.com/privacy', 'developers.google.com/youtube/terms/api-services-terms-of-service'],
    '/privacy': ['Privacy policy', 'YouTube API Services', 'youtube.com/t/terms', 'policies.google.com/privacy',
      'Limited Use', 'myaccount.google.com/permissions', 'sahil.matt@gmail.com', '@BureauofReality', 'href="/terms"'],
    '/terms': ['Terms of service', 'YouTube Terms of Service', 'YouTube API Services Terms of Service',
      'Google Privacy Policy', 'href="/privacy"', 'sahil.matt@gmail.com'],
  };
  for (const [path, needles] of Object.entries(must)) {
    const r = await get(path);
    const html = await r.text();
    check(r.status === 200, `${path} → 200 signed out`, String(r.status));
    const missing = needles.filter((n) => !html.includes(n));
    check(missing.length === 0, `${path} carries everything the audit looks for`, missing.join(', ') || `${needles.length} items`);
  }
  // No client component of their own: the source of the pages and their one shared component.
  const legalSources = ['src/app/(splash)/about/page.tsx', 'src/app/(splash)/privacy/page.tsx', 'src/app/(splash)/terms/page.tsx', 'src/components/legal/legal-page.tsx'];
  const clienty = legalSources.filter((f) => /['"]use client['"]/.test(readFileSync(f, 'utf8')));
  check(clienty.length === 0, 'Server Components: no "use client" in the pages or their frame', clienty.join(', ') || `${legalSources.length} files`);

  console.log('\n2. Everything else still redirects to /login\n');
  check(pages.length > 30, `enumerated ${pages.length} pages from src/app`, pages.map((p) => p.path).slice(0, 3).join(' '));
  let redirected = 0;
  const leaks = [];
  for (const { path } of pages.filter((p) => !isPublic(p.path))) {
    const r = await get(path);
    const loc = r.headers.get('location') ?? '';
    if ((r.status === 307 || r.status === 308) && new URL(loc, BASE).pathname === '/login') redirected++;
    else leaks.push(`${path} → ${r.status} ${loc}`);
  }
  check(leaks.length === 0, `every non-public page redirects a stranger to /login`, leaks.join(' | ') || `${redirected} pages`);
  const publicPages = pages.filter((p) => isPublic(p.path)).map((p) => p.path).sort();
  check(JSON.stringify(publicPages) === JSON.stringify(['/', '/about', '/login', '/onboarding', '/privacy', '/terms']),
    'the public pages are exactly the splash, tour, login and the three legal pages', publicPages.join(' '));

  console.log('\n3. OAuth: consent is gated, discovery is public\n');
  const consent = await get('/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=abc');
  const cl = new URL(consent.headers.get('location') ?? '/', BASE);
  check(consent.status === 307 && cl.pathname === '/login', 'the consent screen redirects a stranger to /login', String(consent.status));
  check(cl.searchParams.get('next') === '/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=abc',
    'with the whole authorize request carried in next', cl.searchParams.get('next'));
  const mcp = await get('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  const www = mcp.headers.get('www-authenticate') ?? '';
  check(mcp.status === 401 && www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`),
    'the real /api/mcp route answers 401 with the discovery header', www);
  const mcpGet = await get('/api/mcp');
  check(mcpGet.status === 401 && (mcpGet.headers.get('www-authenticate') ?? '').includes('resource_metadata='), 'and so does an unauthenticated GET');
  const prm = await get('/.well-known/oauth-protected-resource/api/mcp');
  const prmBody = await prm.json().catch(() => null);
  check(prm.status === 200 && prmBody?.resource === `${BASE}/api/mcp`, 'protected-resource metadata through the real route', prmBody?.resource);
  const asm = await get('/.well-known/oauth-authorization-server');
  const asmBody = await asm.json().catch(() => null);
  check(asm.status === 200 && asmBody?.issuer === BASE && asmBody?.authorization_endpoint === `${BASE}/oauth/authorize`,
    'authorization-server metadata through the real route', asmBody?.issuer);
  const reg = await get('/api/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  const regBody = await reg.json().catch(() => null);
  check(reg.status === 400 && /^redirect_uri_not_allowed/.test(regBody?.error_description ?? ''), 'registration refuses a non-Claude callback through the real route, before any database write', regBody?.error_description);

  console.log('\n4. /setup is never a 404\n');
  const setup = await get('/setup');
  check(setup.status === 307 && new URL(setup.headers.get('location') ?? '/', BASE).pathname === '/login', 'signed out, /setup → /login (not 404)', String(setup.status));
} catch (err) {
  check(false, 'harness threw', err.stack ?? err.message);
}

console.log(failures === 0 ? '\nPublic surface: all checks passed.\n' : `\nPublic surface: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
