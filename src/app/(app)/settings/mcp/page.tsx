import { Panel, SectionHeader } from '@/components/settings/parts';
import { RevokeButton, TokenMint } from '@/components/bureau/token-mint';
import { env } from '@/lib/env';
import { serverClient } from '@/lib/db/server';
import { listChannels } from '@/lib/channels/list';

export const dynamic = 'force-dynamic';

/**
 * MCP tokens for the Bureau control plane.
 *
 * Two kinds in one list (0045). OAuth connections appear here when you approve a Claude
 * connector on the consent screen; static tokens are minted below for Routines and Claude
 * Code's `--header`. Revoke works the same on both — for a connection it ends the current
 * access token immediately and refuses every refresh after it (decision 0016).
 */
export default async function McpTokensPage() {
  const { data: tokens } = await serverClient()
    .from('mcp_tokens')
    // `*` so the list still renders on a database without 0045's `kind` column.
    .select('*')
    .order('created_at', { ascending: false });
  const channels = await listChannels(serverClient());
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const url = `${env.APP_URL.replace(/\/$/, '')}/api/mcp`;

  return (
    <>
      <SectionHeader title="MCP tokens" hint="Bearer tokens for the Kiln connector — approver for you, agent for Routines." />
      <Panel className="mb-5 p-4">
        <p className="mb-2 text-sm">
          Connector URL: <code className="font-mono">{url}</code>.
        </p>
        <p className="mb-2 text-sm">
          <strong className="font-medium">Claude (web and phone):</strong> Customize → Connectors → Add custom
          connector → paste the URL → Add → Connect. Claude opens Kiln&apos;s consent screen; approve it there. The
          connection then appears in the list below as an OAuth row. No token to paste.
        </p>
        <p className="mb-3 text-sm">
          A connector on Claude is visible to every scheduled task on the account, so consent the connection your
          scheduled tasks use with scope <code className="font-mono">agent</code>. Mint a static token below only for
          Routines or Claude Code (<code className="font-mono">--header &quot;Authorization: Bearer kb_…&quot;</code>).
        </p>
        <TokenMint />
      </Panel>
      <Panel className="p-4">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">Name</th>
              <th>Scope</th>
              <th>Kind</th>
              <th>Channel</th>
              <th>Prefix</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(tokens ?? []).map((t) => (
              <tr key={t.id} className={t.revoked_at ? 'opacity-50' : ''}>
                <td className="py-1">{t.name}</td>
                <td>{t.scope}</td>
                <td>{t.kind === 'oauth' ? 'OAuth connection' : 'static'}</td>
                <td>{channelName(t.channel_id)}</td>
                <td className="font-mono">{t.token_prefix}…</td>
                <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleString('en-IN') : '—'}</td>
                <td>{t.revoked_at ? 'revoked' : <RevokeButton id={t.id} />}</td>
              </tr>
            ))}
            {(tokens ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="py-2 text-text-muted">
                  No tokens yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
