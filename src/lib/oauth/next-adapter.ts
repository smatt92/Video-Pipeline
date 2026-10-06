import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

import { serverClient } from '../db/server';
import { fetchClientDocument } from './clients';
import { serveOAuth } from './endpoints';

/**
 * NextRequest → `serveOAuth` → NextResponse. The only framework code in the OAuth server;
 * kept out of tsconfig.verify.json for that reason, like every other adapter here.
 */
export async function oauthRoute(request: NextRequest): Promise<NextResponse> {
  const method = request.method;
  const rawBody = method === 'POST' ? await request.text() : '';
  const result = await serveOAuth(
    {
      method,
      path: request.nextUrl.pathname,
      origin: request.nextUrl.origin,
      contentType: request.headers.get('content-type'),
      authorization: request.headers.get('authorization'),
      rawBody,
    },
    { db: serverClient(), fetchDocument: fetchClientDocument },
  );
  return result.body === null
    ? new NextResponse(null, { status: result.status, headers: result.headers })
    : NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
