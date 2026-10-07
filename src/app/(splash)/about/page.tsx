import type { Metadata } from 'next';
import Link from 'next/link';

import {
  CHANNEL_HANDLE,
  CHANNEL_NAME,
  CONTACT_EMAIL,
  Ext,
  LINKS,
  LegalPage,
  OPERATOR,
  Section,
} from '@/components/legal/legal-page';

/**
 * Kiln's public home page — the "Application home page" on Google's OAuth consent screen.
 * It names the app, says what it does with YouTube data, and links the privacy policy and
 * terms. Public, static, no client JavaScript.
 *
 * `GOOGLE_SITE_VERIFICATION` (optional) renders Search Console's verification meta tag here,
 * which is how the deploy's domain becomes an authorized domain for the consent screen.
 */

export function generateMetadata(): Metadata {
  const google = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  return {
    title: 'Kiln — about',
    description: `Kiln is a private video production tool for the YouTube channel ${CHANNEL_NAME} (${CHANNEL_HANDLE}).`,
    ...(google ? { verification: { google } } : {}),
  };
}

export default function AboutPage() {
  return (
    <LegalPage
      title="Kiln"
      lead={`A private, single-owner tool that plans, produces and publishes short videos for one YouTube channel: ${CHANNEL_NAME} (${CHANNEL_HANDLE}), owned and run by ${OPERATOR}.`}
    >
      <Section title="What Kiln does">
        <p>
          Kiln turns an approved idea into a finished video: it drafts the script, generates the voice and the shots,
          assembles the cut, and holds it for the owner to review. Nothing is published without the owner approving it.
        </p>
        <p>
          It has exactly one user, its owner. There are no sign-ups, no other accounts, and no third-party users; the
          sign-in page admits one address.
        </p>
      </Section>

      <Section title="What Kiln does with YouTube data">
        <p>
          Kiln uses the YouTube API Services. With the owner&apos;s permission, granted through Google&apos;s own
          sign-in, it does two things and nothing else:
        </p>
        <ul className="list-disc pl-5">
          <li>
            <strong className="font-medium">Uploads</strong> videos the owner has approved to the owner&apos;s own
            channel, {CHANNEL_HANDLE} (scope <code className="font-mono">youtube.upload</code>).
          </li>
          <li>
            <strong className="font-medium">Reads that channel&apos;s analytics</strong> — views, watch time, retention
            and similar figures for its own videos — so the owner can see how each video performed (scope{' '}
            <code className="font-mono">yt-analytics.readonly</code>).
          </li>
        </ul>
        <p>
          It does not read, modify or delete anything else on YouTube or in the owner&apos;s Google account, and it
          never accesses any other person&apos;s channel or data. Details are in the{' '}
          <Link href="/privacy" className="underline underline-offset-4" style={{ color: 'var(--ac)' }}>
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Policies">
        <ul className="list-disc pl-5">
          <li>
            <Link href="/privacy" className="underline underline-offset-4" style={{ color: 'var(--ac)' }}>
              Kiln privacy policy
            </Link>
          </li>
          <li>
            <Link href="/terms" className="underline underline-offset-4" style={{ color: 'var(--ac)' }}>
              Kiln terms of service
            </Link>
          </li>
          <li>
            <Ext href={LINKS.youtubeTerms}>YouTube Terms of Service</Ext>
          </li>
          <li>
            <Ext href={LINKS.apiServicesTerms}>YouTube API Services Terms of Service</Ext>
          </li>
          <li>
            <Ext href={LINKS.googlePrivacy}>Google Privacy Policy</Ext>
          </li>
        </ul>
      </Section>

      <Section title="Contact">
        <p>
          {OPERATOR} — <Ext href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Ext>
        </p>
      </Section>
    </LegalPage>
  );
}
