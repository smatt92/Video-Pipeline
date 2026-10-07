'use client';

import { Icon } from '@/components/ui/icon';

/** "Jump to ⌘K" in a page header — opens the same palette the rail does. */
export function JumpButton() {
  return (
    <button type="button" className="btn" onClick={() => window.dispatchEvent(new Event('kiln:palette'))}>
      <Icon name="search" />
      Jump to
      <span className="kbd">⌘K</span>
    </button>
  );
}
