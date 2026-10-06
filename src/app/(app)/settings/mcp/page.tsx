import { Panel, SectionHeader } from '@/components/settings/parts';
import { RevokeButton, TokenMint } from '@/components/bureau/token-mint';
import { env } from '@/lib/env';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * MCP tokens for the Bureau control plane.
 *
 * Mint an approver token for yourself (Claude chat custom connector) and agent tokens for
 * Routines and scheduled tasks. Agent tokens draft, read and queue; they never decide.
 */
export default async function McpTokensPage() {
  const { data: tokens } = await serverClient()
    .from('mcp_tokens')
    .select('id, name, scope, token_prefix, created_at, last_used_at, revoked_at')
    .order('created_at', { ascending: false });
  const url = `${env.APP_URL.replace(/\/$/, '')}/api/mcp`;

  return (
    <>
      <SectionHeader title="MCP tokens" hint="Bearer tokens for the Kiln connector — approver for you, agent for Routines." />
      <Panel className="mb-5 p-4">
        <p className="mb-3 text-sm">
          Connector URL: <code className="font-mono">{url}</code>. In Claude: Settings → Connectors → Add custom
          connector, paste the URL, and put the token in the connector&apos;s authorization (Bearer) field.
        </p>
        <TokenMint />
      </Panel>
      <Panel className="p-4">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">Name</th>
              <th>Scope</th>
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
                <td className="font-mono">{t.token_prefix}…</td>
                <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleString('en-IN') : '—'}</td>
                <td>{t.revoked_at ? 'revoked' : <RevokeButton id={t.id} />}</td>
              </tr>
            ))}
            {(tokens ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-text-muted">
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
