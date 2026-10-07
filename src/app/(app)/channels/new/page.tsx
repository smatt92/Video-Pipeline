import { AddChannelForm } from '@/components/channels/add-channel-form';

export const dynamic = 'force-dynamic';

/**
 * Add channel. Creates the row, policy, publish targets and the channel's bible in the
 * database, started from the template (decision 0022) — no folder, commit or deploy.
 */
export default async function NewChannelPage() {
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <h1 className="text-lg font-medium">Add channel</h1>
      <p className="mt-1 max-w-[640px] text-sm" style={{ color: 'var(--text-muted)' }}>
        The channel starts from the template bible — one host, the default series, policy and trend sources — which you
        then edit here: cast, voices, schedule and caps. Nothing to commit or deploy.
      </p>
      <AddChannelForm />
    </main>
  );
}
