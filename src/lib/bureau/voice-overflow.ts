import { OVERFLOW_TTS_MODEL, type TtsModelName } from '../drivers/voice-route';
import type { VoiceOutcome } from './voice';

/**
 * Voice overflow (O5, `channel_policy.voice_overflow`): what one voice attempt does when the
 * main model's daily limit is reached.
 *
 * In the lib, not the task, so the decision is reachable from a harness (CLAUDE.md: a refusal
 * in a Trigger task is untested). The task owns only the WAIT — a Trigger `wait.for` — and
 * asks this function, each time, whether to wait.
 *
 *   off  → exactly today: the main model's refusal comes back with `wait: true`.
 *   on   → the WHOLE episode is re-voiced on the second model (every speaker re-routed; lines
 *          already spoken on the main model are re-bought and priced first — voice.ts). Never
 *          a mix: a take is re-used only under its own model's key (voiceKey), so whichever
 *          pass completes has spoken every line on one model.
 *          If the second model is limited too → `wait: true`, and the next attempt starts again
 *          from the main model, whose limit is a rolling 24 h and may have freed first.
 *
 * Any failure other than the daily limit is returned as is, with `wait: false` (the task halts).
 */

export const RATE_LIMITED = 'synth_rate_limited';

export interface VoiceAttempt {
  readonly voice: VoiceOutcome;
  /** True → the caller waits and calls again. */
  readonly wait: boolean;
  /** Which pass produced `voice`. */
  readonly path: 'main' | 'overflow';
}

export async function voiceWithOverflow(
  speak: (pass: { model?: TtsModelName; overflowReason?: string }) => Promise<VoiceOutcome>,
  overflowOn: boolean,
): Promise<VoiceAttempt> {
  const main = await speak({});
  if (main.ok || main.code !== RATE_LIMITED) return { voice: main, wait: false, path: 'main' };
  if (!overflowOn) return { voice: main, wait: true, path: 'main' };

  const second = await speak({
    model: OVERFLOW_TTS_MODEL,
    overflowReason: `main model's daily limit — ${main.detail}`,
  });
  if (!second.ok && second.code === RATE_LIMITED) return { voice: second, wait: true, path: 'overflow' };
  return { voice: second, wait: false, path: 'overflow' };
}
