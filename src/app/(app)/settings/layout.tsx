import { SettingsTabs } from '@/components/settings/settings-tabs';

/**
 * Settings frame (canvas: Integrations, Integrations-m): the title, the section tabs, then the
 * section. Anything that would otherwise be a magic number lives somewhere under here.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="main">
      <header className="topbar" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="col" style={{ gap: 4 }}>
          <div className="crumb">
            <span>Workspace</span>
            <span className="t4">/</span>
            <span>Settings</span>
          </div>
          <h1 className="h1">Settings</h1>
          <p className="sm t3">Anything that would otherwise be a magic number lives here.</p>
        </div>
      </header>
      <SettingsTabs />
      <div className="col settings-body" style={{ gap: 16, maxWidth: 1100 }}>
        {children}
      </div>
    </main>
  );
}
