import Link from 'next/link';

import { SETTINGS_SECTIONS } from '@/lib/settings/sections';

/**
 * Settings shell.
 *
 * A second-level nav rather than tabs: ten sections is past the point where top tabs
 * stop being scannable, and this list will grow rather than shrink.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header
        className="flex items-center gap-3 border-b px-5"
        style={{ height: 'var(--topbar-height)', borderColor: 'var(--border-subtle)' }}
      >
        <h1 className="text-md font-medium tracking-tight">Settings</h1>
        <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
          Anything that would otherwise be a magic number lives here
        </span>
      </header>

      <div
        className="grid flex-1"
        style={{ gridTemplateColumns: '212px minmax(0, 1fr)' }}
      >
        <nav className="border-r py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex flex-col gap-px px-2">
            {SETTINGS_SECTIONS.map((s) => {
              const disabled = s.status.kind === 'scaffolded';
              const cls =
                'flex items-center gap-2 rounded-sm px-2 py-[5px] text-sm transition-colors';
              return disabled ? (
                <span
                  key={s.slug}
                  className={`${cls} cursor-not-allowed`}
                  style={{ color: 'var(--text-faint)', transitionDuration: 'var(--duration-fast)' }}
                  title={s.status.kind === 'scaffolded' ? s.status.reason : undefined}
                >
                  <span className="truncate">{s.label}</span>
                  <span
                    className="ml-auto shrink-0 rounded-xs px-1 font-mono text-3xs"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    {s.status.phase}
                  </span>
                </span>
              ) : (
                <Link
                  key={s.slug}
                  href={`/settings/${s.slug}`}
                  className={cls}
                  style={{
                    color: 'var(--text-secondary)',
                    transitionDuration: 'var(--duration-fast)',
                  }}
                >
                  <span className="truncate">{s.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="max-w-[860px] px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
