'use client';

import { Suspense, useEffect, useState } from 'react';

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
/**
 * The ambient layer (Kiln Glass): three drifting orbs in the theme's glow colours, the
 * generating glow, the one-shot red pulse and a static grain tile. Fixed behind every screen;
 * the shell's `data-glow` decides which of them show (glass.css). Decorative, so hidden from
 * assistive tech, and stilled by reduced motion.
 */
export function Ambient() {
  return (
    <>
      <div className="amb" aria-hidden="true">
        <i className="o1" />
        <i className="o2" />
        <i className="o3" />
        <i className="o4" />
      </div>
      <div className="redp" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
    </>
  );
}

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
