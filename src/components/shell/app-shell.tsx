'use client';

import { useState } from 'react';

import { CommandPalette } from './command-palette';
import { HintProvider } from './hint';
import { Sidebar } from './sidebar';

/**
 * The shell: a fixed 260px sidebar and a CSS Grid canvas.
 *
 * Grid rather than flex because the canvas has to hold a card wall, a table and a video
 * player at different times without each of those re-deciding the page layout.
 */
export function AppShell({
  children,
  checklist,
}: {
  children: React.ReactNode;
  /**
   * Rendered by the server layout and passed through, because this component is a Client
   * Component and an async Server Component cannot be constructed inside one. Passing it as
   * a prop is the supported shape and keeps the profile read off the client bundle.
   */
  checklist?: React.ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <HintProvider>
    <div
      className="grid h-dvh"
      style={{ gridTemplateColumns: 'var(--sidebar-width) minmax(0, 1fr)' }}
    >
      <Sidebar checklist={checklist} />
      <main className="overflow-y-auto">{children}</main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
    </HintProvider>
  );
}
