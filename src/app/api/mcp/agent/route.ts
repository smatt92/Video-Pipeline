import { type NextRequest } from 'next/server';

import { mcpGet, mcpPost } from '@/lib/studio/next-route';

/**
 * The agent door: Kiln's MCP server for agent-scoped connections only (decision 0018).
 *
 * A Claude connector is visible to every scheduled task on the account, and Claude offers
 * one connection per connector URL. Sahil's phone holds an approver connection on /api/mcp;
 * the scheduled automations hold a separate connector on this URL, whose OAuth server can
 * issue nothing but agent and whose handler refuses an approver token outright.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return mcpPost(request, 'agent');
}

export function GET(request: NextRequest) {
  return mcpGet(request, 'agent');
}
