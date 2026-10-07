import { AddChannelForm } from '@/components/channels/add-channel-form';
import { BIBLE_SLUGS } from '@/lib/bureau/bible';
import { listChannels } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * Add channel. The bible is files in the repo, so this page creates the row, policy, publish
 * targets and cast for a slug whose folder is already in the build — and refuses any other
 * slug by name, with the command that makes the folder.
 */
export default async function NewChannelPage() {
  const existing = await listChannels(serverClient());
  const free = BIBLE_SLUGS.filter((s) => !existing.some((c) => c.slug === s));
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <h1 className="text-lg font-medium">Add channel</h1>
      <p className="mt-1 max-w-[640px] text-sm" style={{ color: 'var(--text-muted)' }}>
        A channel needs a bible folder — cast, voices, series, policy and trend sources — under
        <span className="font-mono"> channels/&lt;slug&gt;/</span>. Make one on your laptop with
        <span className="font-mono"> pnpm channel:new &lt;slug&gt;</span> (it copies the template), edit it, commit, push and
        deploy the worker; then add the channel here.
      </p>
      <p className="mt-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
        Bible folders in this build with no channel yet: {free.length ? free.join(', ') : 'none'}.
      </p>
      <AddChannelForm slugs={free} />
    </main>
  );
}
