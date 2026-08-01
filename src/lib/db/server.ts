import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../env';
import type { Database } from './types';

/**
 * Supabase client for the server and the worker.
 *
 * `import 'server-only'` on the first line is the point of this file existing separately
 * from `browser.ts`. That package resolves to a module that throws at *build* time when
 * pulled into a client bundle, so a Client Component importing this is a failed build
 * with a clear message — not a runtime leak of a key that bypasses every access control
 * in the database.
 *
 * The runtime `typeof window` guard below is not redundant with it. `server-only` covers
 * the Next bundler; this file also runs inside Trigger.dev containers, which do not go
 * through that bundler at all.
 *
 * The service-role key must be Production-only on both deploy targets. It has no business
 * in a Development environment, where it tends to end up in a shell history or a
 * screenshot.
 */

export type Db = SupabaseClient<Database>;

let singleton: Db | null = null;

export function serverClient(): Db {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverClient() was called in the browser. The service-role key bypasses row-level ' +
        'security entirely and must never reach a client bundle. Move this call into a ' +
        'Server Component, a route handler, or a Trigger task — or use browserClient().',
    );
  }

  singleton ??= createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      // No session to persist and no token to refresh: this client is not a user, it is
      // the application. Leaving these on makes it try to write to a storage that does
      // not exist in a worker.
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'kiln' } },
    },
  );

  return singleton;
}

/** Reset the memoised client. Tests only. */
export function resetServerClientCache(): void {
  singleton = null;
}
