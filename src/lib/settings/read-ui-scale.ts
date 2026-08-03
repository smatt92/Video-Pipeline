import 'server-only';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { coerceUiScale, DEFAULT_UI_SCALE, type UiScale } from './ui-scale';

/**
 * The signed-in profile's UI scale, for the pre-paint value on `<html>`.
 *
 * Every failure returns the default rather than throwing. This runs in the root layout, so
 * a throw here is a blank application — and the correct behaviour when the preference
 * cannot be read is to render at 100%, which is exactly what someone who has never set it
 * gets anyway. A missing preference is not an error state.
 */
export async function readUiScale(): Promise<UiScale> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !checkEmail(user.email).ok) return DEFAULT_UI_SCALE;

    const { data } = await serverClient()
      .from('profiles')
      .select('ui_scale')
      .eq('id', user.id)
      .maybeSingle();

    return data?.ui_scale == null ? DEFAULT_UI_SCALE : coerceUiScale(Number(data.ui_scale));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}
