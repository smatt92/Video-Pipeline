'use client';

import { Tooltip } from '@base-ui/react/tooltip';

/**
 * The one tooltip in the product.
 *
 * Replaces the native `title` attribute, which had three problems: it is unstyleable, it
 * appears after a browser-controlled delay of about a second, and it is invisible to
 * touch and to keyboard users entirely — so any information only available there was
 * effectively not available.
 *
 * Base UI's structure is explicit on purpose and both wrappers are load-bearing:
 *
 *   Portal     — renders the popup at the document root, so it escapes the row's
 *                `overflow` and stacking context instead of being clipped by it.
 *   Positioner — anchors it to the trigger. Without it the popup is laid out in normal
 *                flow and lands wherever the document puts it, which is how a tooltip
 *                ends up detached in a corner with no relationship to what it describes.
 *
 * Neither is automatic. Omitting either compiles, renders, and looks broken only at
 * runtime.
 */
export function Hint({
  children,
  content,
  side = 'top',
}: {
  children: React.ReactNode;
  content: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            className="inline-flex cursor-help items-center"
            // Keyboard-reachable, which the native title attribute never was.
            tabIndex={0}
          />
        }
      >
        {children}
      </Tooltip.Trigger>

      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={7} align="center">
          <Tooltip.Popup
            className="max-w-[280px] rounded-sm border px-2 py-[5px] text-xs leading-snug"
            style={{
              background: 'var(--surface-3)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
              boxShadow: 'var(--shadow-raised)',
            }}
          >
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Wraps the app once. Base UI shares open/close timing across tooltips through this. */
export function HintProvider({ children }: { children: React.ReactNode }) {
  return <Tooltip.Provider delay={220}>{children}</Tooltip.Provider>;
}
