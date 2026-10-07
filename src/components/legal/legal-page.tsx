import Link from 'next/link';
import { KilnMark, Wordmark } from '@/components/ui/logo';

/**
 * The frame for Kiln's three public pages: /about, /privacy, /terms.
 *
 * A Server Component with no client JavaScript of its own — these pages are read by a Google
 * reviewer with no account, and by nobody else, so they are text and links and nothing that
 * could fail to hydrate. Reachable signed out because middleware lists exactly these three
 * paths as public (verify:public asserts it).
 */

export const CONTACT_EMAIL = 'sahil.matt@gmail.com';
export const OPERATOR = 'Sahil Mathew';
export const CHANNEL_HANDLE = '@BureauofReality';
export const CHANNEL_NAME = 'Bureau of Reality';
export const EFFECTIVE = '6 October 2026';

export const LINKS = {
  youtubeTerms: 'https://www.youtube.com/t/terms',
  apiServicesTerms: 'https://developers.google.com/youtube/terms/api-services-terms-of-service',
  googlePrivacy: 'https://policies.google.com/privacy',
  userDataPolicy: 'https://developers.google.com/terms/api-services-user-data-policy',
  googlePermissions: 'https://myaccount.google.com/permissions',
} as const;

export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="underline underline-offset-4" style={{ color: 'var(--ac)' }} rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-medium tracking-tight">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed" style={{ color: 'var(--t2)' }}>
        {children}
      </div>
    </section>
  );
}

export function LegalPage({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[720px] px-6 py-12">
      <nav className="mb-10 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-label="Kiln">
        <Link href="/about" className="lockup" style={{ fontSize: 18, textDecoration: 'none' }} aria-label="Kiln">
          <KilnMark size={20} />
          <Wordmark />
        </Link>
        <Link href="/privacy" style={{ color: 'var(--t3)' }}>
          Privacy
        </Link>
        <Link href="/terms" style={{ color: 'var(--t3)' }}>
          Terms
        </Link>
      </nav>

      <h1 className="mb-3 text-2xl font-medium tracking-tight">{title}</h1>
      {lead && (
        <p className="mb-10 text-md leading-relaxed" style={{ color: 'var(--t2)' }}>
          {lead}
        </p>
      )}

      {children}

      <footer className="mt-12 border-t pt-6 text-xs leading-relaxed" style={{ borderColor: 'var(--b1)', color: 'var(--t3)' }}>
        Kiln is operated by {OPERATOR}. Contact: <Ext href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Ext>. ·{' '}
        <Link href="/privacy" className="underline underline-offset-4">Privacy policy</Link> ·{' '}
        <Link href="/terms" className="underline underline-offset-4">Terms of service</Link>
      </footer>
    </div>
  );
}
