import { SetupChecklist } from './setup-checklist';
import { readSetupProgress } from '@/lib/onboarding/progress';

/**
 * Server half of the checklist: reads the progress, renders nothing when there is none.
 *
 * Split from the widget so the sidebar stays a client component without the profile read
 * being pulled into the bundle with it. Suspended by the caller, so a slow read delays the
 * checklist and not the shell.
 */
export async function ChecklistSlot() {
  const progress = await readSetupProgress();
  if (!progress) return null;
  return <SetupChecklist progress={progress} />;
}
