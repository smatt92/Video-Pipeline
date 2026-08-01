import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

import type { Database } from '../db/types';

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
 * As with `allowed.ts`, the environment is read as literal `process.env.X` rather than
 * through `src/lib/env.ts`: middleware is compiled for the Edge runtime, where only
 * statically-analysable member expressions are inlined.
 */

function config(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Not a soft failure. Without these the client cannot tell a signed-in user from a
    // stranger, and every caller of this module is a gate.
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set. ' +
        'Auth and the onboarding gate both read the session through them, and without ' +
        'them neither can answer.',
    );
  }
  return { url, anonKey };
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
