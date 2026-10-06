#!/usr/bin/env node
/**
 * The deploy-time Vercel env sync (decision 0017), driven without a deploy.
 *
 * PROVES, with stub fetches standing in for api.vercel.com:
 *   - onBuildStart refuses a production deploy without VERCEL_ACCESS_TOKEN, with an absent
 *     required name, with a Sensitive one, with a branch-only one, and on a 403 — each by
 *     name. A throw from onBuildStart fails the deploy (the CLI does not catch it there).
 *   - the listing is requested WITHOUT decrypt, for production, against the right project.
 *   - onBuildComplete runs the real `syncVercelEnvVars`, and the layer it adds carries every
 *     required name; when one does not arrive, the process is stopped (exit 1) rather than
 *     left to the CLI, which would log and deploy anyway.
 *   - staging and dev do nothing at all.
 *   - the required list covers the manifest's required names and the Bureau credentials.
 *
 * DOES NOT PROVE: that the CLI calls these hooks in this order with these shapes in a real
 * deploy, or that Vercel's real listing looks like the stub. Only `npx trigger.dev deploy`
 * can (0008 §17). The stub's shape is the one the extension's own source reads.
 *
 * Usage: node scripts/test-trigger-env.mjs   (after tsc -p tsconfig.verify.json)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { vercelEnv, requiredForWorker, deployEnvironmentFromArgv } = require(`${BUILD}/trigger/vercel-env.js`);
const { vercelEnvProblems } = require(`${BUILD}/trigger/vercel-env-check.js`);
const { requiredWorkerEnv } = require(`${BUILD}/trigger/worker-env.js`);
const { workerCredentialFields } = require(`${BUILD}/drivers/catalog.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

const required = requiredForWorker();
const names = required.map((r) => r.name);

// A Vercel listing with every required name, encrypted and production-wide.
const full = () => names.map((key) => ({ key, type: 'encrypted', target: ['production', 'preview'], gitBranch: undefined, value: `v-${key}` }));

const calls = [];
function stubFetch(envs, status = 200) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const decrypt = u.searchParams.get('decrypt') === 'true';
    const body = status === 200
      ? { envs: envs.map((e) => ({ ...e, value: decrypt && e.type !== 'sensitive' ? e.value : decrypt ? undefined : 'ciphertext' })) }
      : { error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope' } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

const logs = [];
const ctx = (target = 'deploy') => {
  const layers = [];
  return {
    target,
    config: { project: 'proj_test' },
    workingDir: process.cwd(),
    logger: { debug() {}, log: (m) => logs.push(m), warn: (...a) => logs.push(a.join(' ')), progress() {}, spinner: () => ({ stop() {}, message() {} }) },
    addLayer: (l) => layers.push(l),
    getLayers: () => layers,
    layers,
    registerPlugin() {},
    resolvePath: async () => undefined,
  };
};
const manifest = (environment = 'prod') => ({ environment, branch: undefined, deploy: { env: {} } });

async function start(ext, c) {
  try {
    await ext.onBuildStart(c);
    return null;
  } catch (err) {
    return err.message;
  }
}

/** process.exit, caught. */
async function complete(ext, c, m) {
  const real = process.exit;
  let code = null;
  process.exit = (n) => {
    code = n;
    throw new Error(`__exit_${n}`);
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await ext.onBuildComplete(c, m);
  } catch (err) {
    if (!String(err.message).startsWith('__exit_')) throw err;
  } finally {
    process.exit = real;
    console.error = realError;
  }
  return code;
}

const realFetch = globalThis.fetch;
const argv = process.argv;
console.log('\nVercel env sync at deploy\n');
try {
  console.log('1. What is required\n');
  for (const n of requiredWorkerEnv()) check(names.includes(n), `manifest-required ${n} is required`);
  for (const f of workerCredentialFields()) check(names.includes(f.key), `Bureau credential ${f.key} (${f.slug}) is required`);
  check(new Set(names).size === names.length, 'no name twice');

  console.log('\n2. --env\n');
  check(deployEnvironmentFromArgv(['node', 'trigger', 'deploy']) === 'prod', 'default is prod');
  check(deployEnvironmentFromArgv(['node', 'trigger', 'deploy', '--env', 'staging']) === 'staging', '--env staging');
  check(deployEnvironmentFromArgv(['node', 'trigger', 'deploy', '-e', 'staging']) === 'staging', '-e staging');
  check(deployEnvironmentFromArgv(['node', 'trigger', 'deploy', '--env=preview']) === 'preview', '--env=preview');

  console.log('\n3. onBuildStart refuses, by name\n');
  process.argv = ['node', 'trigger.dev', 'deploy'];
  delete process.env.VERCEL_ACCESS_TOKEN;
  globalThis.fetch = stubFetch(full());
  let msg = await start(vercelEnv(), ctx());
  check(/VERCEL_ACCESS_TOKEN is not set/.test(msg ?? ''), 'no token → refused', msg?.split('\n')[2]);
  check(calls.length === 0, 'and nothing was fetched without one');

  process.env.VERCEL_ACCESS_TOKEN = 'tok_test';
  const [absentName] = names;
  globalThis.fetch = stubFetch(full().filter((e) => e.key !== absentName));
  msg = await start(vercelEnv(), ctx());
  check(new RegExp(`${absentName} is not set for Production`).test(msg ?? ''), `an absent required name → refused naming ${absentName}`);

  const sensitiveName = names.find((n) => /KEY|SECRET/.test(n)) ?? names[1];
  globalThis.fetch = stubFetch(full().map((e) => (e.key === sensitiveName ? { ...e, type: 'sensitive' } : e)));
  msg = await start(vercelEnv(), ctx());
  check(new RegExp(`${sensitiveName} is a Sensitive variable`).test(msg ?? '') && /--no-sensitive/.test(msg ?? ''),
    `a Sensitive ${sensitiveName} → refused, with the re-add command`);

  globalThis.fetch = stubFetch(full().map((e) => (e.key === absentName ? { ...e, gitBranch: 'main' } : e)));
  msg = await start(vercelEnv(), ctx());
  check(/only for a git branch/.test(msg ?? ''), 'a branch-only value → refused');

  globalThis.fetch = stubFetch(full().map((e) => (e.key === absentName ? { ...e, target: ['preview'] } : e)));
  msg = await start(vercelEnv(), ctx());
  check(new RegExp(`${absentName} is not set for Production`).test(msg ?? ''), 'a preview-only value → refused as absent from Production');

  globalThis.fetch = stubFetch([], 403);
  msg = await start(vercelEnv(), ctx());
  check(/HTTP 403/.test(msg ?? '') && /different team/.test(msg ?? ''), 'a 403 → refused, naming the likely cause');

  console.log('\n4. The listing it asks for\n');
  calls.length = 0;
  globalThis.fetch = stubFetch(full());
  msg = await start(vercelEnv(), ctx());
  check(msg === null, 'every name present, encrypted → onBuildStart passes', msg ?? '');
  const u = new URL(calls[0]);
  check(u.hostname === 'api.vercel.com' && u.pathname === '/v8/projects/video-pipeline/env', 'the extension\'s endpoint, this project', u.pathname);
  check(u.searchParams.get('decrypt') === null, 'LOAD-BEARING: no decrypt — the check never asks for a value');
  check(u.searchParams.get('target') === 'production' && u.searchParams.get('teamId') === 'team_2UHmmkh8jSZXWBQg8dIICYP5', 'production, the team id');

  console.log('\n5. onBuildComplete runs the real sync, and checks what it produced\n');
  let ext = vercelEnv();
  calls.length = 0;
  globalThis.fetch = stubFetch([...full(), { key: 'EXTRA_THING', type: 'plain', target: ['production'], value: 'x' }]);
  let c = ctx();
  await start(ext, c);
  let code = await complete(ext, c, manifest('prod'));
  const layer = c.layers.find((l) => l.id === 'sync-env-vars');
  check(code === null && !!layer, 'the real syncVercelEnvVars added its layer', `exit ${code}`);
  check(names.every((n) => layer?.deploy?.env?.[n] === `v-${n}`), 'carrying every required name, with the value Vercel decrypted');
  check(layer?.deploy?.env?.EXTRA_THING === 'x', 'and the rest of Vercel production too');
  check(calls.some((x) => new URL(x).searchParams.get('decrypt') === 'true'), 'the sync itself is what asks for decrypted values');

  // The race the pre-check cannot see: a name present when onBuildStart listed, gone (or
  // turned Sensitive) by the time the sync fetches. The CLI would log and deploy.
  ext = vercelEnv();
  c = ctx();
  globalThis.fetch = stubFetch(full());
  await start(ext, c);
  globalThis.fetch = stubFetch(full().map((e) => (e.key === sensitiveName ? { ...e, type: 'sensitive' } : e)));
  code = await complete(ext, c, manifest('prod'));
  check(code === 1, `a required name the sync could not read (${sensitiveName}) → process exits 1`, `exit ${code}`);

  ext = vercelEnv();
  c = ctx();
  code = await complete(ext, c, manifest('prod'));
  check(code === 1, 'production build without the pre-check having run → exit 1');

  console.log('\n6. Production only\n');
  calls.length = 0;
  process.argv = ['node', 'trigger.dev', 'deploy', '--env', 'staging'];
  delete process.env.VERCEL_ACCESS_TOKEN;
  ext = vercelEnv();
  c = ctx();
  msg = await start(ext, c);
  code = await complete(ext, c, manifest('staging'));
  check(msg === null && code === null && c.layers.length === 0 && calls.length === 0, 'staging: no token needed, nothing fetched, nothing synced');
  process.argv = ['node', 'trigger.dev', 'dev'];
  c = ctx('dev');
  msg = await start(vercelEnv(), c);
  code = await complete(vercelEnv(), c, manifest('dev'));
  check(msg === null && code === null && calls.length === 0, 'dev: nothing at all');

  console.log('\n7. The shared predicate\n');
  const p = vercelEnvProblems(
    [{ key: 'A', type: 'encrypted', targets: ['production'], gitBranch: null }, { key: 'B_ALIAS', type: 'plain', targets: ['production'], gitBranch: null }],
    [{ name: 'A', why: 'x' }, { name: 'B', aliases: ['B_ALIAS'], why: 'y' }],
  );
  check(p.length === 0, 'an alias satisfies its name');
} finally {
  globalThis.fetch = realFetch;
  process.argv = argv;
}

console.log(failures === 0 ? '\nVercel env sync: all checks passed.\n' : `\nVercel env sync: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
