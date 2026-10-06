import { ConsentPage } from './consent';

/**
 * The consent screen for the owner door, /api/mcp (decision 0016). The page itself is
 * `consent.tsx`, shared with the agent door's /oauth/agent/authorize (decision 0018).
 */
export const dynamic = 'force-dynamic';

export default function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ConsentPage searchParams={searchParams} door="owner" />;
}
