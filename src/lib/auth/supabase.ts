import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

import type { Database } from '../db/types';
import { readAuthConfig } from './config';

/**
 * Auth-scoped Supabase clients.
 *
 * Separate from `src/lib/db/server.ts` on purpose, and the difference is not stylistic.
 * That client carries the **service-role key**, which bypasses row-level security
 * entirely; it is the application acting as itself. These clients carry the **anon key**
 * plus whatever session cookie the request arrived with, so they act as the signed-in
 * user. Asking "who is this?" with a key that answers "everyone" is how an auth check
 * becomes decorative.
 *
 * Configuration comes from `config.ts`, which explains why this corner reads `process.env`
 * literally instead of through `src/lib/env.ts`. Read that before changing it.
 *
 * These constructors still throw on missing configuration, and that is correct *here* —
 * they are called after the caller has already checked. Middleware checks with
 * `readAuthConfig()` and serves a 503 naming the missing variables rather than letting a
 * throw escape; a route handler or Server Action reaching this state has a genuine bug and
 * should say so loudly.
 */

function config(): { url: string; anonKey: string } {
  const result = readAuthConfig();

  if (!result.ok) {
    throw new Error(
      `Auth is not configured: ${result.missing.join(', ')} ${result.missing.length === 1 ? 'is' : 'are'} missing. ` +
        'Without them this client cannot tell a signed-in user from a stranger. Callers ' +
        'that front user-facing routes should call readAuthConfig() and render the ' +
        'misconfiguration rather than reaching here.',
    );
  }

  return { url: result.config.supabaseUrl, anonKey: result.config.supabaseAnonKey };
}

/**
 * Client for middleware.
 *
 * Supabase refreshes an expired access token during `getUser()`, which means new cookies
 * to write. Middleware can only set cookies on a response it returns, so the caller owns
 * the response object and passes it in — writing to a response that is then discarded
 * silently logs the user out one request later, which presents as "it randomly signs me
 * out" and is very hard to find.
 */
export function middlewareClient(request: NextRequest, response: NextResponse) {
  const { url, anonKey } = config();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
}

/**
 * Client for Server Components, Server Actions and route handlers.
 *
 * `cookies()` is read-only inside a Server Component, and Next throws if you write to it
 * there. That is why `setAll` swallows: the token refresh that middleware already
 * performed on this same request has written the fresh cookies, so there is nothing lost
 * — but only because middleware runs on every matched path. If the matcher ever stops
 * covering a route, sessions on that route stop refreshing.
 */
export async function routeClient() {
  const { url, anonKey } = config();
  const { cookies } = await import('next/headers');
  const store = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // Server Component render. Middleware owns the refresh; see above.
        }
      },
    },
  });
}
