import type { Metadata } from 'next';

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

/**
 * Kiln's privacy policy, for Google's OAuth consent screen and the YouTube API audit. Written
 * to the YouTube API Services Developer Policies' privacy-policy requirements: it says the
 * app uses YouTube API Services, links the YouTube Terms and the Google Privacy Policy, says
 * what is accessed, stored, used and shared, and how to revoke access and have data deleted.
 * Public, static, no client JavaScript.
 */

export const metadata: Metadata = {
  title: 'Kiln — privacy policy',
  description: 'What Kiln does with YouTube and Google account data.',
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" lead={`Effective ${EFFECTIVE}. Kiln is a private tool operated by ${OPERATOR} for his own YouTube channel, ${CHANNEL_HANDLE}. It has no other users.`}>
      <Section title="YouTube API Services">
        <p>
          Kiln uses the YouTube API Services. By authorizing Kiln you agree to the{' '}
          <Ext href={LINKS.youtubeTerms}>YouTube Terms of Service</Ext>, and Google&apos;s handling of your data is
          described in the <Ext href={LINKS.googlePrivacy}>Google Privacy Policy</Ext>. Kiln&apos;s use of these
          services is subject to the <Ext href={LINKS.apiServicesTerms}>YouTube API Services Terms of Service</Ext>.
        </p>
      </Section>

      <Section title="What Kiln accesses">
        <p>Only the owner&apos;s own account, and only through the two permissions the owner grants:</p>
        <ul className="list-disc pl-5">
          <li>
            <code className="font-mono">youtube.upload</code> — to upload videos the owner has approved to the
            owner&apos;s channel. Kiln sends the video file, its title, description, tags and scheduling; it reads back
            the new video&apos;s ID so it can link to it.
          </li>
          <li>
            <code className="font-mono">yt-analytics.readonly</code> — to read performance figures (views, watch time,
            average view duration, retention, subscribers gained and similar) for the owner&apos;s own videos.
          </li>
        </ul>
        <p>
          Kiln does not access any other YouTube channel, any other person&apos;s data, or any other part of the
          owner&apos;s Google account. It does not read email, contacts, files or location.
        </p>
      </Section>

      <Section title="What Kiln stores, and where">
        <ul className="list-disc pl-5">
          <li>
            The OAuth refresh token Google issues, held in Kiln&apos;s encrypted secret store (or the private environment of
            its background worker) and never in an ordinary database column, so Kiln can upload and read analytics
            without asking the owner to sign in each time.
          </li>
          <li>
            For each uploaded video: its YouTube video ID, URL and upload status.
          </li>
          <li>
            Analytics figures for the owner&apos;s videos, as dated snapshots, so the owner can compare how videos
            performed over time.
          </li>
          <li>The owner&apos;s sign-in session, as a cookie used only to keep the owner signed in.</li>
        </ul>
        <p>
          This data is kept in Kiln&apos;s database and storage (hosted on Supabase) and served by its web application
          (hosted on Vercel). It is not sold, not used for advertising, and not shared with anyone other than the
          service providers that host Kiln.
        </p>
      </Section>

      <Section title="How Kiln uses it">
        <p>
          Only to provide Kiln&apos;s features to its owner: publishing the owner&apos;s approved videos and showing
          the owner how they performed. When the owner asks their own AI assistant (Claude, by Anthropic) for a report
          through Kiln&apos;s connector, the figures for the owner&apos;s channel may be included in that answer to the
          owner. Nothing is used to train models.
        </p>
        <p>
          Kiln&apos;s use and transfer of information received from Google APIs adheres to the{' '}
          <Ext href={LINKS.userDataPolicy}>Google API Services User Data Policy</Ext>, including the Limited Use
          requirements.
        </p>
      </Section>

      <Section title="Revoking access and deleting data">
        <p>
          Access can be revoked at any time on Google&apos;s{' '}
          <Ext href={LINKS.googlePermissions}>security settings page</Ext> (Third-party apps &amp; services → Kiln →
          Remove access). Once access is revoked Kiln can no longer upload or read analytics.
        </p>
        <p>
          To have Kiln delete the stored token, video records and analytics snapshots, email{' '}
          <Ext href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Ext>; they are deleted within 7 days. The same
          data is deleted within 7 days of access being revoked, whether or not anyone asks.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          If this policy changes, the new version will be posted here with a new effective date. Questions:{' '}
          {OPERATOR}, <Ext href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Ext>.
        </p>
      </Section>
    </LegalPage>
  );
}
