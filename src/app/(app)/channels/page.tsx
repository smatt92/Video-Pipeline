import Link from 'next/link';

import { TargetForm } from '@/components/channels/target-form';
import { listChannels, publishTargets } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/** Every channel, its bible, and where it publishes — the place to set an account id. */
export default async function ChannelsPage() {
  const db = serverClient();
  const channels = await listChannels(db);
  const rows = await Promise.all(channels.map(async (c) => ({ c, t: await publishTargets(db, c.id) })));
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-medium">Channels</h1>
        <Link href="/channels/new" className="text-sm" style={{ color: 'var(--ac)' }}>+ Add channel</Link>
      </div>
      <div className="mt-4 grid gap-4">
        {rows.map(({ c, t }) => (
          <section key={c.id} className="rounded-md border p-4" style={{ borderColor: 'var(--b2)' }}>
            <h2 className="text-md font-medium">{c.name} <span className="text-2xs font-normal" style={{ color: 'var(--t3)' }}>{c.handle ?? 'no handle'} · bible {c.slug ? `channels/${c.slug}/` : '—'}{c.slug && !c.hasBible ? ' (not in this build)' : ''}</span></h2>
            {!t.fromTable && <p className="mt-1 text-2xs" style={{ color: 'var(--blk-text)' }}>Publish targets need migration 0046 — paste docs/bureau/hosted-migrations-5-0046.sql. Until then this channel publishes to its single platform.</p>}
            <div className="mt-2 grid gap-2">
              {(['youtube', 'instagram'] as const).map((p) => {
                const x = t.targets.find((y) => y.platform === p);
                return <TargetForm key={p} channelId={c.id} platform={p} enabled={x?.enabled ?? false} handle={x?.handle ?? null} externalId={x?.externalId ?? null} />;
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
