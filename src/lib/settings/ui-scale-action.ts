'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { isUiScale, type UiScale } from './ui-scale';

export interface ScaleState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

/**
 * Persist the display scale.
 *
 * Validated against the closed set here as well as by the CHECK constraint. The constraint
 * is the one that matters; this exists so a bad value is a sentence rather than a Postgres
 * error, and because the set is a product decision that lives in TypeScript.
 */
export async function setUiScaleAction(scale: number): Promise<ScaleState> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { status: 'error', message: 'Not signed in.' };
    if (!checkEmail(user.email).ok) return { status: 'error', message: 'Not permitted.' };

    if (!isUiScale(scale)) {
      return {
        status: 'error',
        message:
          `${scale} is not one of the steps. The set is closed on purpose — an arbitrary ` +
          'multiplier produces fractional pixel values and 1px borders start rendering at ' +
          'different weights on adjacent edges.',
      };
    }

    const { error } = await serverClient()
      .from('profiles')
      .update({ ui_scale: scale as UiScale })
      .eq('id', user.id);

    if (error) return { status: 'error', message: error.message };

    // Every page, because the scale is on the root layout's <html>.
    revalidatePath('/', 'layout');
    return { status: 'ok', message: `Display scale set to ${Math.round(scale * 100)}%.` };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
