'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Hint } from '@/components/shell/hint';
import { NAV, type NavItem } from '@/lib/nav';

/**
 * 260px sidebar.
 *
 * Disabled routes stay visible with the reason they are disabled, rather than being
 * hidden until they work. Seeing the whole shape of the product — including the parts
 * that are blocked on a Meta review that started in week one — is more useful than a nav
 * that quietly grows.
 */

function Item({ item, active }: { item: NavItem; active: boolean }) {
  const disabled = item.status.kind === 'disabled';

  const inner = (
    <>
      <span className="truncate">{item.label}</span>
      {disabled && (
        <span
          className="ml-auto shrink-0 rounded-xs px-1 font-mono text-[10px] leading-4"
          style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
        >
          {item.status.phase}
        </span>
      )}
    </>
  );

  const base =
    'flex items-center gap-2 rounded-sm px-2 py-[5px] text-[13px] transition-colors';

  if (disabled && item.status.kind === 'disabled') {
    return (
      <Hint content={`${item.hint}. ${item.status.reason}.`} side="right">
        <span
          className={`${base} w-full cursor-not-allowed`}
          style={{ color: 'var(--text-faint)', transitionDuration: 'var(--duration-fast)' }}
          aria-disabled
        >
          {inner}
        </span>
      </Hint>
    );
  }

  return (
    <Link
      href={item.href}
      className={base}
      style={{
        background: active ? 'var(--sidebar-item-active-bg)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        transitionDuration: 'var(--duration-fast)',
        boxShadow: active ? 'inset 2px 0 0 var(--accent)' : undefined,
      }}
      aria-current={active ? 'page' : undefined}
    >
      {inner}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      className="flex h-full flex-col border-r"
      style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex items-center gap-2 px-4" style={{ height: 'var(--topbar-height)' }}>
        <span
          aria-hidden
          className="size-[7px] rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        <span className="text-[13px] font-medium tracking-tight">Kiln</span>
        <span className="ml-auto font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
          phase 1
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((group) => (
          <div key={group.label} className="mb-5">
            <div
              className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: 'var(--text-faint)' }}
            >
              {group.label}
            </div>
            <div className="flex flex-col gap-px">
              {group.items.map((item) => (
                <Item
                  key={item.href}
                  item={item}
                  active={pathname === item.href}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

    </nav>
  );
}
