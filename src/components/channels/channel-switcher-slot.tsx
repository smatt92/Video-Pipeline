import { currentChannel } from '@/lib/channels/active';

import { ChannelSwitcher } from './channel-switcher';

/** Server half: reads the channels and the cookie; the switcher itself is a client widget. */
export async function ChannelSwitcherSlot() {
  try {
    const { active, all } = await currentChannel();
    return <ChannelSwitcher channels={all.map((c) => ({ id: c.id, name: c.name, handle: c.handle, hasBible: c.hasBible }))} activeId={active?.id ?? null} />;
  } catch {
    // Signed out, or the database unreachable: the sidebar still renders, without a switcher.
    return null;
  }
}
