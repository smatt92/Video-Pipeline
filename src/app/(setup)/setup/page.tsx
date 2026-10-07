import Link from 'next/link';

import { SetupFrame } from '@/components/onboarding/spine';
import { Icon } from '@/components/ui/icon';
import { KilnObject } from '@/components/ui/kiln-object';
import { serverClient } from '@/lib/db/server';
import { readSpine } from '@/lib/onboarding/spine';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kiln — setup' };

/**
 * Setup start (canvas: Onb-Start). Resumes where it was left: the first page that is not done,
 * named, with the one sentence it blocks. First run shows "Start setup" and an empty spine.
 * Every page link resolves (the old /setup/<step> slugs redirect to the page that shows them).
 */
export default async function SetupStart() {
  const spine = await readSpine();
  const name = spine.progress.userId
    ? (await serverClient().from('profiles').select('display_name').eq('id', spine.progress.userId).maybeSingle()).data?.display_name ?? null
    : null;
  const fresh = spine.doneCount === 0;
  const resume = spine.resume;
  const blocker = spine.blockers.find((b) => b.slug === resume.slug)?.text ?? null;

  return (
    <SetupFrame spine={spine}>
      <section className="card bp" style={{ padding: 28, display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
        <KilnObject width={150} label="The kiln" />
        <div className="col" style={{ gap: 10, flex: '1 1 280px' }}>
          <span className="lbl">Setup · {spine.doneCount} of 10 done</span>
          <h1 className="ob-h bp-text">
            {fresh
              ? 'Set up the studio, then your first channel.'
              : resume.slug === 'finish'
                ? `${name ? `${name}, n` : 'N'}othing blocks your first episode.`
                : `Welcome back${name ? `, ${name}` : ''}. You stopped at ${resume.label.toLowerCase()}.`}
          </h1>
          <p className="sm bp-text-2">
            {blocker ?? (fresh ? 'Ten short pages. Every key is tested with a real call; nothing spends money until a step says so.' : 'Fire your first episode: approve a brief, watch the cut, approve it, download the bundle.')}
          </p>
          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <Link className="btn pri lg" href={`/setup/${resume.slug}`}>
              {fresh ? 'Start setup' : `Resume at ${resume.label}`}
            </Link>
            {!fresh && (
              <Link className="btn lg" href="/setup/studio">
                Review earlier steps
              </Link>
            )}
          </div>
        </div>
      </section>

      <div className="kgrid ga-220">
        <div className="card card-b col" style={{ gap: 8 }}>
          <span className="mono xs tac">Studio · once</span>
          <span className="h3">Steps 1–4</span>
          <span className="sm t2">You, storage, model keys, the rate card. Shared by every channel.</span>
        </div>
        <div className="card card-b col" style={{ gap: 8 }}>
          <span className="mono xs tac">Channel · repeatable</span>
          <span className="h3">Steps 5–8</span>
          <span className="sm t2">Basics, cast and voices, series and slots, caps and trends. Runs again from + Add channel.</span>
        </div>
        <div className="card card-b col" style={{ gap: 8 }}>
          <span className="mono xs tac">Finish</span>
          <span className="h3">First episode</span>
          <span className="sm t2">Approve a brief, watch the cut, approve it, download the bundle.</span>
        </div>
      </div>

      <section className="card card-b row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Icon name="key" />
        <div className="col" style={{ gap: 4 }}>
          <span className="h3">Keys stay where you host Kiln</span>
          <span className="sm t2">
            Kiln reads each variable, tests it with the provider, and says whether it found it — never the value. A key typed into a field here goes to Vault and only its last four
            characters are ever shown. To change a key, change it where it lives, then press Save and test.
          </span>
        </div>
      </section>
    </SetupFrame>
  );
}
