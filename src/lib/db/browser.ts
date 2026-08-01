import { createBrowserClient } from '@supabase/ssr';

import { env } from '../env';
import type { Database } from './types';

/**
 * Supabase client for the browser.
 *
 * Carries the anon key, which is publishable by design — it is inlined into the client
 * bundle and anyone can read it out of DevTools. That is fine, *provided* row-level
 * security is doing the work of deciding what it can reach.
 *
 * In Phase 1 it is not: `docs/SCHEMA.sql` declares no RLS policies, so the anon key today
 * is an unlocked door rather than a reduced privilege. Until policies exist, this client
 * is deliberately unused — data reaches the page through Server Components, and every
 * write goes through the server client. See `docs/decisions/0003-no-rls-in-phase-1.md`.
 *
 * It exists now so that the split is structural from the start. Adding a browser client
 * later, once forty components have grown used to importing whatever is nearest, is how
 * a service-role key ends up in a bundle.
 */
export function browserClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
