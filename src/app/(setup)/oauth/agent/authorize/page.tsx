import { ConsentPage } from '../../authorize/consent';

/**
 * The consent screen for the agent door, /api/mcp/agent (decision 0018): the same page as
 * /oauth/authorize, with the scope fixed to agent and no approver option.
 */
export const dynamic = 'force-dynamic';

export default function AgentAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ConsentPage searchParams={searchParams} door="agent" />;
}
