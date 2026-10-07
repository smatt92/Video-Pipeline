#!/usr/bin/env node
/**
 * Copy channels/_template/ to channels/<slug>/, set its "channel" field, regenerate the
 * registry. The one half of "Add channel" that has to happen in the repo (Vercel cannot
 * commit); the other half is the Add channel form, which refuses a slug until this folder is
 * deployed.
 *
 * Usage: pnpm channel:new <slug>
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
  console.error('usage: pnpm channel:new <slug>   (lowercase letters, digits and hyphens)');
  process.exit(2);
}
const dest = `channels/${slug}`;
if (existsSync(dest)) {
  console.error(`${dest}/ already exists — refusing to overwrite it.`);
  process.exit(1);
}
cpSync('channels/_template', dest, { recursive: true });
const p = `${dest}/characters.json`;
const j = JSON.parse(readFileSync(p, 'utf8'));
j.channel = slug;
writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
execFileSync(process.execPath, ['scripts/channels-registry.mjs'], { stdio: 'inherit' });
console.log(`\nNext: edit every REPLACE in ${dest}/, commit, push, deploy the worker, then Add channel in the sidebar.`);
