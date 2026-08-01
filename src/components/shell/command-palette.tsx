'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { NAV } from '@/lib/nav';

/**
 * ⌘K palette.
 *
 * Disabled routes appear here too, greyed with their reason. Searching for "publish" and
 * finding nothing suggests the feature does not exist; finding it disabled with "blocked
 * on Meta app review" is the answer to the question actually being asked.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

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

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50"
    >
      <div
        className="fixed inset-0"
        style={{ background: 'var(--overlay-scrim)' }}
        onClick={() => onOpenChange(false)}
      />
      <div
        className="fixed left-1/2 top-[18vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border"
        style={{
          background: 'var(--surface-2)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-overlay)',
        }}
      >
        <Command.Input
          autoFocus
          placeholder="Search screens…"
          className="w-full border-b bg-transparent px-4 py-3 text-[14px] outline-none"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />
        <Command.List className="max-h-[52vh] overflow-y-auto p-2">
          <Command.Empty
            className="px-3 py-6 text-center text-[13px]"
            style={{ color: 'var(--text-muted)' }}
          >
            Nothing matches.
          </Command.Empty>

          {NAV.map((group) => (
            <Command.Group
              key={group.label}
              heading={group.label}
              className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.09em]"
              style={{ color: 'var(--text-faint)' }}
            >
              {group.items.map((item) => {
                const disabled = item.status.kind === 'disabled';
                return (
                  <Command.Item
                    key={item.href}
                    value={`${item.label} ${item.hint}`}
                    disabled={disabled}
                    onSelect={() => {
                      if (disabled) return;
                      onOpenChange(false);
                      router.push(item.href);
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-[7px] text-[13px] data-[selected=true]:bg-[var(--surface-3)]"
                    style={{ color: disabled ? 'var(--text-faint)' : 'var(--text-primary)' }}
                  >
                    <span className="shrink-0">{item.label}</span>
                    <span className="truncate text-[12px]" style={{ color: 'var(--text-faint)' }}>
                      {disabled && item.status.kind === 'disabled'
                        ? item.status.reason
                        : item.hint}
                    </span>
                    {disabled && item.status.kind === 'disabled' && (
                      <span
                        className="ml-auto shrink-0 rounded-xs px-1 font-mono text-[10px]"
                        style={{ background: 'var(--surface-3)' }}
                      >
                        {item.status.phase}
                      </span>
                    )}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
