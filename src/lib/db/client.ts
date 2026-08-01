import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../env';
import type { Database } from './types';

export type Db = SupabaseClient<Database>;

/**
 * Supabase clients.
 *
 * Phase 1 is single-user and the schema in `docs/SCHEMA.sql` declares no RLS policies,
 * which means the anon key is not a security boundary here — it is an unlocked door.
 * Until policies exist, every write goes through the service-role client on the server
 * or in a Trigger task, and the browser gets data via Server Components. See
 * `docs/decisions/0003-no-rls-in-phase-1.md`.
 */

let serviceSingleton: Db | null = null;

/**
 * Full-privilege client. Server and worker only — it bypasses RLS entirely.
 *
 * The runtime guard is not decoration. `SUPABASE_SERVICE_ROLE_KEY` has no NEXT_PUBLIC_
 * prefix so Next will not inline it into a client bundle, but a stray import of this
 * module from a Client Component is a build-time footgun worth failing loudly on.
 */
export function serviceClient(): Db {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serviceClient() was called in the browser. The service role key bypasses RLS and ' +
        'must never reach a client bundle. Move this call into a Server Component, a ' +
        'route handler, or a Trigger task.',
    );
  }

  serviceSingleton ??= createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'kiln' } },
  });

  return serviceSingleton;
}

/**
 * Anon-key client, for the browser. Carries no elevated privilege — and, until RLS
 * policies exist, no privilege boundary either.
 */
export function anonClient(): Db {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: true },
  });
}

/** Reset the memoised service client. Tests only. */
export function resetDbCache(): void {
  serviceSingleton = null;
}
