'use client';

import { Icon } from '@/components/ui/icon';

export function MobileSearch() {
  return (
    <button
      type="button"
      className="btn icon"
      aria-label="Search or jump"
      style={{ width: 44, height: 44, borderRadius: 12, flex: 'none' }}
      onClick={() => window.dispatchEvent(new Event('kiln:palette'))}
    >
      <Icon name="search" />
    </button>
  );
}
