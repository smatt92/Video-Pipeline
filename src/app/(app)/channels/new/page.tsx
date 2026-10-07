import { redirect } from 'next/navigation';

/**
 * + Add channel lives in setup now (canvas: Onb-ChBasics) — Basics, then Cast, Schedule and
 * Caps for the new channel. This path stays so links written before the redesign still land.
 */
export default function NewChannelPage(): never {
  redirect('/setup/basics?new=1');
}
