import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkEmail } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';
import { currentChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { fetchClientDocument } from '@/lib/oauth/clients';
import { DOORS, originFromHeaders, type McpDoor } from '@/lib/oauth/policy';
import { AUTHORIZE_PARAM_NAMES, authorizeParamsFrom, checkAuthorize } from '@/lib/oauth/flow';

import { decideAgentAction, decideOwnerAction } from './actions';
import { Lockup } from '@/components/ui/logo';

/**
 * The consent screen for a Claude connector (decision 0016).
 *
 * Reached only signed in: middleware sends anyone without an allowed session to /login with
 * this URL — query string included — as `next`, and the page re-checks ALLOWED_EMAIL itself.
 *
 * It shows the three things a person needs to decide: who is asking (the client's name and
 * the id it identified with), where the code will go (the redirect URI — the one value an
 * attacker would need to change), and what the connection may do (the scope, preselected to
 * approver). Agent is the right choice for the connection the scheduled tasks use, because
 * a Claude connector is visible to every scheduled task on the account.
 *
 * No client JavaScript: a form posting to a Server Action, two submit buttons.
 */

const SCOPE_COPY: Record<'approver' | 'agent', { title: string; body: string }> = {
  approver: {
    title: 'Approver',
    body: 'Everything an agent can do, plus approve and reject briefs and cuts, mark bundles scheduled, set caps and flip the kill switch. For you, in Claude chat.',
  },
  agent: {
    title: 'Agent',
    body: 'Read, draft briefs, queue dubs and ask for a shot regeneration. Can never approve, publish, change caps or flip the kill switch. For scheduled tasks.',
  },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col justify-center px-6 py-12">
      <div className="mb-7">
        <Lockup fontSize={18} />
      </div>
      {children}
    </div>
  );
}

function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <Shell>
      <h1 className="mb-2 text-xl font-medium tracking-tight">{title}</h1>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--t2)' }}>
        {detail}
      </p>
      <p className="mt-4 text-xs" style={{ color: 'var(--t3)' }}>
        Nothing was sent to the client. Close this tab and try connecting again from Claude.
      </p>
    </Shell>
  );
}

export async function ConsentPage({
  searchParams,
  door,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  door: McpDoor;
}) {
  const raw = await searchParams;
  const params = authorizeParamsFrom((n) => {
    const v = raw[n];
    return Array.isArray(v) ? v[0] : v;
  });

  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !checkEmail(user.email).ok) {
    return <Refusal title="Not permitted" detail="Only the Kiln owner, signed in, can approve a connection." />;
  }

  const h = await headers();
  const origin = originFromHeaders((n) => h.get(n));
  const db = serverClient();
  const check = await checkAuthorize(db, params, origin, fetchClientDocument, door);
  if (!check.ok) {
    if (check.redirectTo) redirect(check.redirectTo);
    return <Refusal title="This connection request was refused" detail={check.error.description} />;
  }

  // The code names a person (oauth_codes.profile_id → profiles); without the row the insert
  // would fail after the click. Said now, with the fix.
  const { data: profile } = await db.from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (!profile) {
    return (
      <Refusal
        title="Finish your profile first"
        detail="A connection records the person who approved it, and your profile row does not exist yet. Complete setup step 1 (Profile), then connect again."
      />
    );
  }

  const { client, redirectUri, suggestedScope } = check.request;
  const { active: channel } = await currentChannel();

  return (
    <Shell>
      <h1 className="mb-2 text-xl font-medium tracking-tight">Connect {client.clientName} to Kiln?</h1>
      <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--t2)' }}>
        It will be able to use Kiln&apos;s Bureau tools as you, with the scope you choose below. You can revoke it at
        any time on Settings → MCP tokens.
      </p>

      <dl
        className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-sm border px-3 py-3 text-xs"
        style={{ borderColor: 'var(--b1)', background: 'var(--in)' }}
      >
        <dt style={{ color: 'var(--t3)' }}>Client</dt>
        <dd className="break-all">{client.clientName}</dd>
        <dt style={{ color: 'var(--t3)' }}>Client ID</dt>
        <dd className="break-all font-mono">{client.clientId}</dd>
        <dt style={{ color: 'var(--t3)' }}>Sends you back to</dt>
        <dd className="break-all font-mono">{redirectUri}</dd>
        <dt style={{ color: 'var(--t3)' }}>Signed in as</dt>
        <dd className="break-all">{user.email}</dd>
        <dt style={{ color: 'var(--t3)' }}>Channel</dt>
        <dd className="break-all">
          {channel ? `${channel.name}${channel.handle ? ` (${channel.handle})` : ''} — the active channel; switch it in Kiln's sidebar to connect another` : 'none — add a channel in Kiln first'}
        </dd>
      </dl>

      <form action={door === 'agent' ? decideAgentAction : decideOwnerAction} className="flex flex-col gap-4">
        {AUTHORIZE_PARAM_NAMES.map((n) => {
          const v = params[n];
          return v === null ? null : <input key={n} type="hidden" name={n} value={v} />;
        })}

        {door === 'agent' ? (
          // Fixed, and said so. No radio: this door's token endpoint refuses to mint approver
          // whatever this form posts, and a choice that cannot be exercised is not offered.
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Scope: {SCOPE_COPY.agent.title}</p>
            <input type="hidden" name="grant_scope" value="agent" />
            <p className="text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
              {SCOPE_COPY.agent.body}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
              This is the agent connector ({DOORS.agent.mcpPath}). It can only ever be agent — this is the one your
              Claude scheduled tasks use. Your own approver connection is a separate connector on{' '}
              {DOORS.owner.mcpPath}.
            </p>
          </div>
        ) : (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Scope</legend>
              {DOORS.owner.scopes.map((s) => (
                <label
                  key={s}
                  className="flex cursor-pointer gap-3 rounded-sm border px-3 py-2"
                  style={{ borderColor: 'var(--b1)' }}
                >
                  <input type="radio" name="grant_scope" value={s} defaultChecked={s === suggestedScope} className="mt-1" />
                  <span>
                    <span className="block text-sm font-medium">{SCOPE_COPY[s].title}</span>
                    <span className="block text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
                      {SCOPE_COPY[s].body}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <p className="text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
              A connector on Claude is visible to every scheduled task on your Claude account. For the scheduled tasks,
              add a separate connector on {DOORS.agent.mcpPath} — it can only ever be agent.
            </p>
          </>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            name="decision"
            value="approve"
            className="rounded-sm px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--ac)', color: 'var(--ac-ink)' }}
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded-sm border px-4 py-2 text-sm"
            style={{ borderColor: 'var(--b3)' }}
          >
            Deny
          </button>
        </div>
      </form>
    </Shell>
  );
}
