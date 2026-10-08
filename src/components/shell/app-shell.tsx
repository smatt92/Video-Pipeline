'use client';

import { Suspense, useEffect, useState } from 'react';

import { SceneDefs } from '@/components/ui/episode';
import type { RailData } from '@/lib/shell/rail';

import { CommandPalette } from './command-palette';
import { HintProvider } from './hint';
import { NavFeedback } from './nav-feedback';
import { Rail } from './rail';
import { TabBar } from './tab-bar';

/**
 * The application frame (canvas: Rail + TabBar). Rail on the left from 768px up; the tab bar
 * and its More sheet below that. Both read the same RailData, built once per request on the
 * server, so a badge on the rail and on the tab bar can never disagree.
 *
 * The content column scrolls with the document rather than inside a fixed-height box, so a
 * phone's browser chrome can collapse and the page never scrolls sideways at 390px.
 */
export function AppShell({ children, data }: { children: React.ReactNode; data: RailData }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener('kiln:palette', open);
    return () => window.removeEventListener('kiln:palette', open);
  }, []);

  return (
    <HintProvider>
      <SceneDefs />
      {/* Suspended because it reads the search params; it renders a 2px bar and nothing else. */}
      <Suspense fallback={null}>
        <NavFeedback />
      </Suspense>
      <a href="#content" className="sr-only">
        Skip to content
      </a>
      <div className="shell">
        <div className="shell-rail">
          <Rail data={data} onOpenPalette={() => setPaletteOpen(true)} />
        </div>
        <div className="shell-main" id="content">
          {children}
        </div>
        <div className="shell-tabs">
          <TabBar data={data} />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} data={data} />
    </HintProvider>
  );
}
