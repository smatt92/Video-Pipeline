import 'server-only';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';

/**
 * Whether the person viewing a Settings screen is the approver — the same test the actions
 * apply, so a control is enabled exactly when its action would accept. The actions refuse on
 * their own regardless; this only keeps a screen from offering what it would then refuse.
 */
export async function viewerIsApprover(): Promise<boolean> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return !!user && checkEmail(user.email).ok;
  } catch {
    return false;
  }
}
