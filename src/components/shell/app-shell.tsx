'use client';

import { Suspense, useEffect, useState } from 'react';

import { Ambient } from '@/components/glass/ambient';
import { SceneDefs } from '@/components/ui/episode';
import type { RailData } from '@/lib/shell/rail';

import { CommandPalette } from './command-palette';
import { HintProvider } from './hint';
import { NavFeedback } from './nav-feedback';
import { TabBar } from './tab-bar';
import { TopBar } from './top-bar';

/**
 * The application frame (canvas: GlassHome, GlassHomeM). The top bar on every width; the
 * glass tab bar and its More sheet below 768px. Both read the same RailData, built once per
 * request on the server, so a badge on the bar and on the tab bar can never disagree.
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
      <div className="shell" data-glow={data.glow}>
        <Ambient />
        <TopBar data={data} onOpenPalette={() => setPaletteOpen(true)} />
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
