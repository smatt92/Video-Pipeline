import { notFound, redirect } from 'next/navigation';

import { BasicsPage, CapsPage, CastPage, SchedulePage } from '@/components/onboarding/pages/channel';
import { ConnectionsPage, FinishPage } from '@/components/onboarding/pages/finish';
import { GenerationPage, ModelsPage, RatesPage, StudioPage } from '@/components/onboarding/pages/studio';
import { SetupFrame } from '@/components/onboarding/spine';
import { pageForStep, setupPage } from '@/lib/onboarding/pages';
import { readSpine } from '@/lib/onboarding/spine';
import { stepBySlug } from '@/lib/onboarding/steps';

/**
 * One setup page (canvas: Onb-*). A page slug renders that page inside the spine; an old
 * wizard step slug (/setup/profile, /setup/channel, …) redirects to the page that now shows
 * the step, so every link written before the redesign still lands.
 *
 * Per-user by definition — the spine is this user's ticks and this channel's rows.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kiln — setup' };

export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { step: slug } = await params;
  const sp = await searchParams;
  const page = setupPage(slug);
  if (!page) {
    const old = stepBySlug(slug);
    if (old) redirect(`/setup/${pageForStep(old.n).slug}`);
    notFound();
  }

  const spine = await readSpine(page.slug);
  const fresh = sp.new === '1';
  const pick = typeof sp.c === 'string' ? sp.c : null;

  return (
    <SetupFrame spine={spine}>
      {page.slug === 'studio' && <StudioPage spine={spine} />}
      {page.slug === 'models' && <ModelsPage spine={spine} />}
      {page.slug === 'generation' && <GenerationPage spine={spine} />}
      {page.slug === 'rate-card' && <RatesPage spine={spine} />}
      {page.slug === 'basics' && <BasicsPage spine={spine} fresh={fresh} />}
      {page.slug === 'cast' && <CastPage spine={spine} pick={pick} />}
      {page.slug === 'schedule' && <SchedulePage spine={spine} />}
      {page.slug === 'caps' && <CapsPage spine={spine} />}
      {page.slug === 'connections' && <ConnectionsPage spine={spine} />}
      {page.slug === 'finish' && <FinishPage spine={spine} />}
    </SetupFrame>
  );
}
