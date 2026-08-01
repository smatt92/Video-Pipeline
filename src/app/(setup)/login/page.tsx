import { SIGN_IN_REFUSED } from '@/lib/auth/allowed';

import { SignInForm } from './sign-in-form';

/**
 * Sign in.
 *
 * The only route in the product reachable without a session, and it holds nothing — no
 * workspace name, no vendor list, no hint about which address is the permitted one. A
 * preview deployment is a public URL, and this is the page a stranger sees.
 */

export const metadata = { title: 'Kiln — sign in' };

const DENIALS: Record<string, string> = {
  not_allowed: SIGN_IN_REFUSED,
  unconfigured: SIGN_IN_REFUSED,
  no_code: 'That sign-in link was incomplete. Request a new one.',
  exchange_failed: 'That sign-in link has expired or was already used. Request a new one.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; denied?: string }>;
}) {
  const { next, denied } = await searchParams;
  const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
  const message = denied ? (DENIALS[denied] ?? DENIALS.not_allowed) : null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[400px] flex-col justify-center px-6 py-12">
      <div className="mb-7 flex items-center gap-2">
        <span
          aria-hidden
          className="size-[7px] rounded-full"
          style={{ background: 'var(--brand-mark)' }}
        />
        <span className="text-[13px] font-medium tracking-tight">Kiln</span>
      </div>

      <h1 className="mb-2 text-[19px] font-medium tracking-tight">Sign in</h1>
      <p className="mb-6 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Single-tenant. One address is permitted, set at deploy time.
      </p>

      {message && (
        <div
          className="mb-5 rounded-sm border px-3 py-2 text-[12px] leading-relaxed"
          style={{
            borderColor: 'var(--border-strong)',
            background: 'var(--surface-inset)',
            color: 'var(--text-muted)',
          }}
        >
          {message}
        </div>
      )}

      <SignInForm next={safeNext} />
    </div>
  );
}
