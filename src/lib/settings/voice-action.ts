'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';

/**
 * Set a channel's host voice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this small thing is worth its own file
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It is the difference between the pipeline being *structurally able* to run and *running*.
 * `channels.host_voice_id` is the value stage 4 reads to decide whether to hand a script to
 * stage 6; with it null, stage 6 never runs, durations stay estimates, and stage 5 refuses
 * every shot. Four complete stages, green harnesses, and no output — see STATE.md §8.
 *
 * Adding the column fixed the schema. Until something can *write* it, the chain is still
 * inert for everyone who is not running SQL by hand, which is the whole point of closing
 * that distinction immediately rather than later.
 *
 * ── Not validated against the vendor's voice list, deliberately ──────────────
 *
 * A voice id is checked by the vendor at render time, and checking it here would mean a
 * live API call inside a settings write — slow, failable, and dependent on a credential
 * that may not be configured yet. The failure mode of a wrong id is a stage 6 error row
 * naming the voice, which is legible; the failure mode of a validating write is a settings
 * screen that cannot save while the vendor is down.
 *
 * What *is* enforced is that the string is a plausible id rather than a display name, since
 * "Rachel" is the single most likely thing to be pasted here and it will fail at render
 * time with a message about an unknown voice.
 */

export interface VoiceState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

/** Vendor voice ids are opaque tokens. A name with a space is the common mistake. */
const PLAUSIBLE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function setHostVoiceAction(
  channelId: string,
  voiceId: string,
  language = 'en',
): Promise<VoiceState> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { status: 'error', message: 'Not signed in.' };
    if (!checkEmail(user.email).ok) return { status: 'error', message: 'Not permitted.' };

    const trimmed = voiceId.trim();

    // Clearing is legitimate and is not an error. Someone changing vendors wants the chain
    // to stop rather than to keep rendering with a voice that no longer exists.
    if (trimmed === '') {
      const { error } = await serverClient()
        .from('channels')
        .update({ host_voice_id: null })
        .eq('id', channelId);
      if (error) return { status: 'error', message: error.message };
      revalidatePath('/settings/voice');
      return {
        status: 'ok',
        message:
          'Cleared. Stage 6 will not run unattended, so approved concepts will stop after ' +
          'the shotlist — visible in the blocker column rather than silently.',
      };
    }

    if (!PLAUSIBLE_ID.test(trimmed)) {
      return {
        status: 'error',
        message:
          `"${trimmed}" does not look like a voice id. Vendors use opaque tokens — letters, ` +
          'digits, dashes — rather than display names. If you pasted "Rachel" or similar, ' +
          'the id is next to it in the vendor\'s voice list.',
      };
    }

    const { error } = await serverClient()
      .from('channels')
      .update({ host_voice_id: trimmed, voice_language: language })
      .eq('id', channelId);

    if (error) return { status: 'error', message: error.message };

    revalidatePath('/settings/voice');
    return {
      status: 'ok',
      message:
        'Saved. Approved concepts will now chain through to a submitted generation without ' +
        'a human in the middle — the voice is what stage 4 was waiting for.',
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
