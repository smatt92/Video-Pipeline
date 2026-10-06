import type { Metadata } from 'next';
import Link from 'next/link';

import {
  CHANNEL_HANDLE,
  CONTACT_EMAIL,
  EFFECTIVE,
  Ext,
  LINKS,
  LegalPage,
  OPERATOR,
  Section,
} from '@/components/legal/legal-page';

/** Kiln's terms of service. Public, static, no client JavaScript. */

export const metadata: Metadata = {
  title: 'Kiln — terms of service',
  description: 'Terms for Kiln, a private single-owner video production tool.',
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" lead={`Effective ${EFFECTIVE}.`}>
      <Section title="What Kiln is">
        <p>
          Kiln is a private video production tool operated by {OPERATOR} for his own YouTube channel, {CHANNEL_HANDLE}.
          It is not offered to the public: only its owner can sign in, and there are no other accounts.
        </p>
      </Section>

      <Section title="YouTube">
        <p>
          Kiln uses the YouTube API Services to upload the owner&apos;s approved videos and read the owner&apos;s channel
          analytics. Using those features means agreeing to the{' '}
          <Ext href={LINKS.youtubeTerms}>YouTube Terms of Service</Ext>, and Kiln is bound by the{' '}
          <Ext href={LINKS.apiServicesTerms}>YouTube API Services Terms of Service</Ext>. Google&apos;s handling of data
          is described in the <Ext href={LINKS.googlePrivacy}>Google Privacy Policy</Ext>; Kiln&apos;s is in its{' '}
          <Link href="/privacy" className="underline underline-offset-4" style={{ color: 'var(--accent)' }}>
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Content">
        <p>
          The owner is responsible for every video Kiln publishes. Nothing is uploaded without the owner&apos;s
          approval, and the owner remains bound by YouTube&apos;s Community Guidelines and policies for what is
          uploaded.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          Kiln is provided as is, for its owner&apos;s own use, without warranty of any kind. Its operator is not liable
          for any loss arising from its use.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          These terms may change; the current version is always on this page with its effective date. Contact:{' '}
          <Ext href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Ext>.
        </p>
      </Section>
    </LegalPage>
  );
}
