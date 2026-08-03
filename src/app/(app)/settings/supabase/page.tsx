import { CheckPill, Mono, NotSet, Panel, Row, SectionHeader } from '@/components/settings/parts';

/**
 * Supabase — diagnostic, not editable.
 *
 * The bootstrap paradox: Vault lives inside Supabase, so the credentials needed to reach
 * Supabase cannot themselves live in Vault. Three things therefore stay in environment
 * variables and are shown here as present/absent only:
 *
 *   - the Supabase URL and keys
 *   - the webhook callback base URL, needed before any integration record can be read
 *
 * The value of this screen is that at 1am, one place tells you whether the problem is
 * Supabase. A settings page with greyed fields and no explanation reads as broken, so it
 * says why in plain words rather than leaving you to infer it.
 */

const BOOTSTRAP = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', present: true, last4: null, note: 'Client-published by design' },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', present: true, last4: 'a91f', note: 'Client-published by design' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', present: true, last4: '77c2', note: 'Server and worker only. Production only.' },
  { key: 'WEBHOOK_CALLBACK_BASE_URL', present: true, last4: null, note: 'Needed before any integration record can be read' },
];

const DIAGNOSTICS = [
  { label: 'Connection', value: null, help: 'Round-trip latency to the project' },
  { label: 'Migration version', value: null, help: 'Latest row in supabase_migrations.schema_migrations' },
  { label: 'Vault health', value: null, help: 'Runs pnpm verify:vault — create, read back, delete a canary secret' },
  { label: 'Storage usage', value: null, help: 'Bucket size and object count' },
  { label: 'Database size', value: null, help: 'pg_database_size' },
];

/**
 * RLS per table. Currently off everywhere by design (decision 0003), which is safe only
 * while the anon key is not published — and it *is* published, by definition. This table
 * is where that stops being a footnote and becomes something you look at.
 */
const RLS = [
  'channels',
  'concepts',
  'scripts',
  'shots',
  'generations',
  'assets',
  'renders',
  'reviews',
  'publications',
  'integrations',
];

export default function SupabasePage() {
  return (
    <>
      <SectionHeader
        title="Supabase"
        hint="Diagnostic only. Nothing on this page is editable, and that is not an oversight — see below."
      />

      <div
        className="mb-5 rounded-sm border px-3 py-2 text-xs leading-relaxed"
        style={{
          borderColor: 'var(--border-strong)',
          background: 'var(--surface-inset)',
          color: 'var(--text-muted)',
        }}
      >
        <strong className="font-medium" style={{ color: 'var(--text-secondary)' }}>
          Why these are env vars and not Vault entries.
        </strong>{' '}
        Vault lives inside Supabase. Reading the Supabase credentials out of Vault would
        require the Supabase credentials, so these three must come from the environment.
        The same applies to the webhook callback base URL, which is needed before any
        integration record can be loaded. Everything else moved to Vault.
      </div>

      <SectionHeader title="Bootstrap environment" />
      <Panel className="mb-5">
        {BOOTSTRAP.map((b) => (
          <Row key={b.key} label={b.key} help={b.note}>
            <div className="flex items-center gap-3">
              <CheckPill passed={b.present} label={b.present ? 'present' : 'absent'} />
              {b.last4 ? <Mono>…{b.last4}</Mono> : null}
            </div>
          </Row>
        ))}
      </Panel>

      <SectionHeader
        title="Diagnostics"
        hint="Every one of these requires a live connection. None has run."
      />
      <Panel className="mb-5">
        {DIAGNOSTICS.map((d) => (
          <Row key={d.label} label={d.label} help={d.help}>
            {d.value ?? <NotSet />}
          </Row>
        ))}
      </Panel>

      <SectionHeader
        title="Row-level security"
        hint="Off on every table. Deliberate for a single user, and a hard prerequisite for Phase 3."
      />
      <Panel>
        <div className="flex flex-wrap gap-[6px] p-4">
          {RLS.map((t) => (
            <span
              key={t}
              className="rounded-xs px-[6px] py-[3px] font-mono text-2xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
            >
              {t} · off
            </span>
          ))}
        </div>
      </Panel>

      <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        With RLS off the anon key is not a reduced privilege — it is full read and write to
        every table, and it ships in the client bundle. That is acceptable only while the
        project is not publicly reachable. Before channel tokens exist, policies must.
      </p>
    </>
  );
}
