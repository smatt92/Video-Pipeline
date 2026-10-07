'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { episodeState } from '@/components/ui/tags';
import { killSwitchAction } from '@/lib/bureau/ui-actions';
import { NAV } from '@/lib/nav';
import type { RailData } from '@/lib/shell/rail';
import { UI_SCALES, labelFor, UI_SCALE_STORAGE_KEY } from '@/lib/settings/ui-scale';
import { setUiScaleAction } from '@/lib/settings/ui-scale-action';

/**
 * ⌘K (canvas: Palette). Scoped to the active channel: its slots, its pending briefs, its kill
 * switch. Approving, scheduling and the kill switch need the approver token — the palette only
 * routes to them, and the kill switch asks to confirm (and for a reason) before it acts.
 *
 * Also keeps the two things it carried before the redesign: replaying the tour / finishing
 * setup, and the display-scale actions — the palette is where someone reaches when the UI is
 * too small to comfortably navigate to Settings.
 */
export function CommandPalette({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: RailData;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const active = data.channels.find((c) => c.id === data.activeId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const kill = () => {
    if (!data.activeId || !data.kill) return;
    onOpenChange(false);
    const on = data.kill.on;
    if (on) {
      if (!window.confirm(`Turn the kill switch off for ${active?.name ?? 'this channel'}? Generation and publishing resume.`)) return;
      start(async () => {
        window.alert((await killSwitchAction(data.activeId!, false, '')).message);
        router.refresh();
      });
    } else {
      const reason = window.prompt(`Stop ${active?.name ?? 'this channel'}: no new generation, no publishing. Reason (logged verbatim):`);
      if (!reason) return;
      start(async () => {
        window.alert((await killSwitchAction(data.activeId!, true, reason)).message);
        router.refresh();
      });
    }
  };

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" className="fixed inset-0 z-50">
      <div className="fixed inset-0" style={{ background: 'var(--scrim)' }} onClick={() => onOpenChange(false)} />
      <div className="raised palette">
        <div className="row" style={{ gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--b1)', flexWrap: 'nowrap' }}>
          <Icon name="search" className="t3" size={18} />
          <Command.Input
            autoFocus
            placeholder="Search slots, screens, actions…"
            aria-label="Command"
            className="grow"
            style={{ background: 'transparent', border: 0, outline: 0, color: 'var(--t1)', font: '400 16px var(--sans)', minWidth: 0 }}
          />
          {active && (
            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span className="chm" />
              <span className="xs t3">{active.name}</span>
            </span>
          )}
          <span className="kbd">esc</span>
        </div>
        <Command.List>
          <Command.Empty className="sm t3" style={{ padding: '24px 12px', textAlign: 'center' }}>
            Nothing matches.
          </Command.Empty>

          {data.slots.length > 0 && (
            <Command.Group heading="Slots">
              {data.slots.map((s) => {
                const st = episodeState(s.status);
                return (
                  <Command.Item key={s.episodeId} value={`${s.slot} ${s.title} ${st.label}`} onSelect={() => go(`/bureau/board#${s.episodeId}`)}>
                    <span className="mono" style={{ width: 52, color: 'var(--t1)', flex: 'none' }}>
                      {s.slot}
                    </span>
                    <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || '—'}
                    </span>
                    <span className={`pill s-${st.tone}`}>{st.label}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}

          <Command.Group heading="Actions">
            {data.pendingBriefs.map((b) => (
              <Command.Item key={b.id} value={`review brief ${b.slot ?? ''} ${b.premise}`} onSelect={() => go('/bureau/approvals')}>
                <Icon name="approvals" />
                <span className="grow">Review brief {b.slot ?? '(bank)'}</span>
              </Command.Item>
            ))}
            <Command.Item value="switch to all channels combined" onSelect={() => go('/all')}>
              <Icon name="channels" />
              <span className="grow">Switch to All channels</span>
            </Command.Item>
            {data.activeId && data.kill && (
              <Command.Item value="kill switch stop pipeline resume" onSelect={kill}>
                <Icon name="power" className="tblk" />
                <span className="grow">
                  {data.kill.on ? 'Turn kill switch off…' : 'Kill switch…'} <span className="t3">asks to confirm</span>
                </span>
              </Command.Item>
            )}
            <Command.Item value="replay product tour onboarding what is kiln intro explain" onSelect={() => go('/onboarding')}>
              <Icon name="info" />
              <span className="grow">Replay the product tour</span>
            </Command.Item>
            <Command.Item value="finish setup onboarding wizard connect accounts add channel" onSelect={() => go('/setup')}>
              <Icon name="setup" />
              <span className="grow">Setup — studio and channels</span>
            </Command.Item>
          </Command.Group>

          {NAV.map((group) => (
            <Command.Group key={group.label} heading={group.label}>
              {group.items.map((item) => {
                const disabled = item.status.kind === 'disabled';
                return (
                  <Command.Item
                    key={item.href}
                    // The section name is searchable too: "library" must find Characters, Voices,
                    // Prompts and Music, not fuzzy-match a slot title (Sahil, 07-Oct).
                    value={`${item.label} ${group.label} ${item.hint}`}
                    disabled={disabled}
                    onSelect={() => !disabled && go(item.href)}
                  >
                    <Icon name={item.icon as IconName} />
                    <span style={{ flex: 'none' }}>{item.label}</span>
                    <span className="xs t3 grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.status.kind === 'disabled' ? item.status.reason : item.hint}
                    </span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}

          <Command.Group heading="Display">
            {UI_SCALES.map((scale) => (
              <Command.Item
                key={scale}
                value={`UI scale ${labelFor(scale)} display size zoom bigger smaller`}
                onSelect={() => {
                  document.documentElement.style.setProperty('--ui-scale', String(scale));
                  try {
                    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
                  } catch {
                    /* private mode; the profile value is authoritative */
                  }
                  onOpenChange(false);
                  void setUiScaleAction(scale);
                }}
              >
                <span>UI scale — {labelFor(scale)}</span>
                <span className="xs t3">applies immediately, saved to your profile</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
        <div className="row sb" style={{ padding: '10px 16px', borderTop: '1px solid var(--b1)' }}>
          <span className="xs t3">Scoped to {active ? 'this channel' : 'the workspace'} · approving, scheduling and the kill switch need the approver token</span>
          <span className="row xs t3" style={{ gap: 6 }}>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            move
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}
