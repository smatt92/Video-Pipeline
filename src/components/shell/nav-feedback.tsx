'use client';

import { useLinkStatus } from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Navigation feedback for the whole app (08-Oct: "the UI transitions are super slow or there
 * are no transition effects, which implies lag").
 *
 * Every app screen is a dynamic Server Component, so before this a click showed nothing at
 * all until the server had finished every query. Three cheap signals now say "heard you":
 *
 *   1. The nav item pressed shows it at once (`LinkPending`, below, and `:active` in CSS).
 *   2. A thin bar runs along the top from the click until the new screen's real content is in
 *      — not merely until the URL changes, because with the loading skeletons (loading.tsx)
 *      the URL changes almost at once and the data arrives later. It watches for the
 *      skeleton (`[data-skeleton]`) to leave the page.
 *   3. Coming back to the tab or the window after a while re-reads the screen, so a status
 *      the worker changed while you were away is not shown stale (the rail's badges with it).
 *
 * No dependency: a bar is a div and two transitions. Under reduced motion the global rule in
 * tokens.css removes the transitions; the bar still appears and goes, without moving.
 */

/** Seconds away after which coming back re-reads the screen. */
const STALE_AFTER_MS = 20_000;

function isInternalNavigation(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  // Same screen (a hash link, or the item you are already on): nothing will load.
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  // Route handlers and file downloads are not screens.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return null;
  return url.pathname + url.search;
}

export function NavFeedback() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const started = useRef<number | null>(null);
  const lastRead = useRef(Date.now());

  // 2. Start on a click that will navigate, and on back/forward.
  useEffect(() => {
    const begin = () => {
      started.current = Date.now();
      setPhase('loading');
    };
    const onClick = (e: MouseEvent) => {
      if (isInternalNavigation(e)) begin();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', begin);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', begin);
    };
  }, []);

  // …and finish once the URL has changed AND the skeleton has been replaced by the screen.
  const key = `${pathname}?${search?.toString() ?? ''}`;
  useEffect(() => {
    lastRead.current = Date.now();
    if (started.current === null) return;
    let raf = 0;
    const deadline = Date.now() + 15_000;
    const settle = () => {
      if (document.querySelector('[data-skeleton]') && Date.now() < deadline) {
        raf = window.requestAnimationFrame(settle);
        return;
      }
      started.current = null;
      setPhase('done');
    };
    raf = window.requestAnimationFrame(settle);
    return () => window.cancelAnimationFrame(raf);
  }, [key]);

  // A click that never navigated (a refused action, a link to the same data) must not leave
  // the bar running: give up after a while.
  useEffect(() => {
    if (phase === 'loading') {
      const t = window.setTimeout(() => {
        started.current = null;
        setPhase('done');
      }, 15_000);
      return () => window.clearTimeout(t);
    }
    if (phase === 'done') {
      const t = window.setTimeout(() => setPhase('idle'), 400);
      return () => window.clearTimeout(t);
    }
  }, [phase]);

  // 3. Re-read on return.
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRead.current < STALE_AFTER_MS) return;
      lastRead.current = Date.now();
      router.refresh();
    };
    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, [router]);

  return <div className="navbar" data-phase={phase} aria-hidden="true" />;
}

/**
 * Put inside a nav `<Link>`: marks it while its navigation is pending, so the item you
 * tapped lights up before the screen arrives (CSS: `:has(> .lp[data-pending])`).
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return <span className="lp" data-pending={pending ? '' : undefined} aria-hidden="true" />;
}
