#!/usr/bin/env node
/**
 * Write a channel's rows as SQL for the Supabase SQL editor — made by the REAL admin path, not
 * written by hand.
 *
 * The hosted project is reachable from a build session only to read (0008), so a new channel
 * goes there as a paste. Rather than hand-write the rows `createChannel` would make (and drift
 * from it the first time it changes), this runs `createChannel` itself on a scratch database
 * — the template folder, the policy row, the publish targets, the bible, the cast sync, the
 * authorship row — applies the channel's own settings through the same functions the app uses
 * (`setPublishTarget`), seeds its bank topics, and dumps exactly the rows that resulted.
 *
 * Used for Built Like That (0052): both publish targets recorded OFF with no account id —
 * Sahil creates the accounts and adds them on Settings → Channels — the drawn-share floor at
 * 25% so "full motion" can mean clips on most beats, and twenty undated bank topics (no slot
 * date, so the daily safety net drafts nothing until Sahil dates one). The output also
 * activates the picture-clip recipe 0052 seeds retired, in one visible statement.
 *
 * Usage: node scripts/channel-sql.mjs <admin-db-url> <out.sql>
 *   (needs `tsc -p tsconfig.verify.json` first, like the harnesses)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const [dbUrl, out] = process.argv.slice(2);
if (!dbUrl || !out) {
  console.error('usage: node scripts/channel-sql.mjs <admin-db-url> <out.sql>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { createChannel } = require(`${B}/channels/bible-admin.js`);
const { setPublishTarget } = require(`${B}/channels/add.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

const SLUG = 'built-like-that';
const scratch = await scratchDatabase(dbUrl, 'channelsql');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
try {
  const made = await createChannel(db, { scope: 'approver', profileId: null, via: 'bundle:channel-sql' }, {
    name: 'Built Like That',
    slug: SLUG,
    handle: '@BuiltLikeThat',
    instagram_handle: '@BuiltLikeThat',
    niche: 'How everyday engineering works and why it is built that way',
    targets: ['youtube', 'instagram'],
    template: SLUG,
  });
  if (!made.ok) throw new Error(made.refused);
  const id = made.channelId;
  for (const platform of ['youtube', 'instagram']) {
    const r = await setPublishTarget(db, id, { platform, enabled: false, handle: '@BuiltLikeThat' });
    if (!r.ok) throw new Error(r.refused);
  }
  await q('update channel_policy set overlay_min_share = 0.25 where channel_id = $1', [id]);
  const rows = readFileSync('data/built-like-that-topics.csv', 'utf8').trim().split('\n').slice(1);
  const names = { evolution: 'Every Attempt Failed', inside: 'The Machine Inside' };
  for (const line of rows) {
    const m = /^(B\d{2}),(evolution|inside),(.*?),(.*)$/.exec(line);
    if (!m) throw new Error(`bad topic line: ${line}`);
    await q(`insert into slots (id, channel_id, kind, slot_date, series, series_name, lead, topic, hook, topic_status, notes) values ($1, $2, 'bank', null, $3, $4, 'narrator', $5, $6, 'bank', 'Built Like That seed (0052)')`, [m[1], id, m[2], names[m[2]], m[3], m[4]]);
  }

  // Dump: every row the path wrote, table by table in FK order, as jsonb_populate_recordset so
  // types and quoting are Postgres's own, never this script's.
  const tables = [
    ['channels', 'id = $1'],
    ['channel_policy', 'channel_id = $1'],
    ['channel_publish_targets', 'channel_id = $1'],
    ['channel_bibles', 'channel_id = $1'],
    ['channel_characters', 'channel_id = $1'],
    ['characters', 'channel_id = $1'],
    ['slots', 'channel_id = $1'],
    ['authorship_log', 'channel_id = $1'],
  ];
  const parts = [];
  for (const [t, where] of tables) {
    const data = await q(`select * from ${t} where ${where} order by 1`, [id]);
    if (!data.length) continue;
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' and identity_generation is null order by ordinal_position`, [t])).map((r) => r.column_name).filter((c) => c in data[0]);
    const list = cols.map((c) => `"${c}"`).join(', ');
    const json = JSON.stringify(data.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))));
    if (json.includes('$kiln$')) throw new Error('dollar-quote collision');
    parts.push(`-- ${t}: ${data.length} row(s)\ninsert into ${t} (${list})\nselect ${list} from jsonb_populate_recordset(null::${t}, $kiln$${json}$kiln$::jsonb);`);
  }
  const sql = `-- ════════════════════════════════════════════════════════════════════════════
-- Built Like That (@BuiltLikeThat) — the channel, made by createChannel (scripts/channel-sql.mjs)
-- GENERATED. Do not edit; regenerate with: node scripts/channel-sql.mjs <db-url> <out.sql>
--
--   · the channel row, its policy (caps as the Bureau's: ₹150 / ₹600 / ₹15,000; drawn-share
--     floor 25%), both publish targets recorded OFF with no account id
--   · its bible from channels/built-like-that/ (one off-screen narrator; series "Every Attempt
--     Failed" and "The Machine Inside", both defaulting to the 3D explainer, key motion, brisk)
--   · 20 bank topics (B17–B36, undated: nothing is drafted until one is dated)
--   · the picture-clip recipe 0052 seeded retired, ACTIVATED (the last statement)
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_channel$
begin
  if exists (select 1 from channels where slug = '${SLUG}') then
    raise exception 'Already applied: a channel with slug ${SLUG} exists. Nothing in this file has been run and the transaction is rolling back.';
  end if;
end
$kiln_channel$;

${parts.join('\n\n')}

-- The 3D explainer's clips: one recipe, activated here rather than by the migration (0052).
-- Delete this statement before pasting if you would rather watch a clip first; until it runs,
-- both motion levels plan their clips as pictures and Approvals says so.
update prompts set is_active = true, retired_at = null, retired_reason = null
 where name = 'engineered-picture-clip-gen4-turbo' and version = 1;
`;
  writeFileSync(out, sql);
  console.log(`wrote ${out}: channel ${id}, ${parts.length} tables`);
} finally {
  await scratch.release();
}
