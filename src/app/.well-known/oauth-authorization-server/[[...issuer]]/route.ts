import { type NextRequest } from 'next/server';

import { oauthRoute } from '@/lib/oauth/next-adapter';

/** Discovery document for /api/mcp's OAuth server (decision 0016). Logic: src/lib/oauth/endpoints.ts. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return oauthRoute(request);
}

export function OPTIONS(request: NextRequest) {
  return oauthRoute(request);
}
