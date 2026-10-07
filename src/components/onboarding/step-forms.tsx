'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { StepState } from '@/lib/onboarding/actions';
import {
  confirmRateCard,
  createChannel,
  runStepCheck,
  saveProfile,
} from '@/lib/onboarding/actions';
import type { StepIntegrationView } from '@/lib/onboarding/step-view';

/**
 * The wizard's forms.
 *
 * ── Write-only secret fields ─────────────────────────────────────────────────
 *
 * Every credential input below is empty on render and has no `defaultValue`. There is no
 * code path that could fill one, because the server never sends a secret to this component
 * — `StepIntegrationView.secrets` carries `last_4` and two timestamps and nothing else. A
 * blank box next to "configured, ends 4f2a" is the whole design: it means "leave it" on
 * submit, so rotating one field of three does not require retyping the other two.
 *
 * `autoComplete="off"` on all of them. A password manager offering to save an API key it
 * scraped from a form is a copy of the credential nobody decided to make.
 */

const IDLE: StepState = { status: 'idle' };

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn pri"
    >
      {pending ? busy : label}
    </button>
  );
}

function Field({
  name,
  label,
  help,
  type = 'text',
  defaultValue,
  placeholder,
  required,
  autoComplete = 'off',
}: {
  name: string;
  label: string;
  help?: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span className="sm t2" style={{ fontWeight: 500 }}>
        {label}
        {required && <span aria-hidden> *</span>}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        spellCheck={false}
        className="input"
      />
      {help && <span className="xs t3">{help}</span>}
    </label>
  );
}

/** Result of the last submit. Required failures read as errors; informational ones do not. */
function Outcome({ state }: { state: StepState }) {
  if (state.status === 'idle') return null;
  const ok = state.status === 'ok';
  return (
    <div className="col" style={{ gap: 8 }} role="status">
      {state.message &&
        (ok ? (
          <div className="row sm" style={{ gap: 8, color: 'var(--live)', alignItems: 'flex-start', flexWrap: 'nowrap', whiteSpace: 'pre-line' }}>
            <span aria-hidden="true">✓</span>
            <span>{state.message}</span>
          </div>
        ) : (
          <div className="blocker">
            <span aria-hidden="true" className="tblk">!</span>
            <p style={{ whiteSpace: 'pre-line' }}>{state.message}</p>
          </div>
        ))}
      {state.checks && state.checks.length > 0 && (
        <ul className="col" style={{ gap: 6, margin: 0, padding: 0, listStyle: 'none' }}>
          {state.checks.map((c) => (
            <li key={c.name} className="row xs" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <span aria-hidden className="dot" style={{ marginTop: 5, background: c.passed ? 'var(--live)' : c.required ? 'var(--blk)' : 'var(--draft)' }} />
              <span className="t2">
                <span className="mono t3">
                  {c.name}
                  {!c.required && ' · informational'}
                </span>
                <br />
                {c.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 1 — Profile
// ═════════════════════════════════════════════════════════════════════════════

export function ProfileForm({
  email,
  defaults,
}: {
  email: string | null;
  defaults?: { displayName: string | null; timezone: string | null; currency: string | null; usdInrRate: number | null };
}) {
  const [state, action] = useActionState(saveProfile, IDLE);

  return (
    <form action={action} className="col" style={{ gap: 14 }}>
      <div className="kgrid ga-220">
        <Field name="display_name" label="Your name" placeholder="Sahil" defaultValue={defaults?.displayName ?? undefined} />
        <Field name="timezone" label="Timezone" defaultValue={defaults?.timezone ?? 'Asia/Kolkata'} />
        <Field name="currency" label="Currency" defaultValue={defaults?.currency ?? 'INR'} />
        <Field
          name="usd_inr_rate"
          label="1 USD in INR"
          placeholder="88.5"
          defaultValue={defaults?.usdInrRate != null ? String(defaults.usdInrRate) : undefined}
          help="Every rupee figure derives from this. Snapshotted onto each cost row, so changing it later does not rewrite history."
        />
      </div>
      {email && (
        <p className="xs t3">Signed in as {email}. The profile is written against this account.</p>
      )}
      <div>
        <Submit label="Save profile" busy="Saving…" />
      </div>
      <Outcome state={state} />
    </form>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Steps 2–5 and 11 — credentials, then a real call
// ═════════════════════════════════════════════════════════════════════════════

export function IntegrationStepForm({
  stepNumber,
  view,
  verification,
  fieldsHidden = false,
  label = 'Save and test',
}: {
  stepNumber: number;
  view: StepIntegrationView;
  verification: string;
  /** Run the check on what is already configured (Vault or environment) — no fields drawn. */
  fieldsHidden?: boolean;
  label?: string;
}) {
  const [state, action] = useActionState(runStepCheck.bind(null, stepNumber), IDLE);

  const configured = new Map(view.secrets.map((s) => [s.fieldKey, s]));

  return (
    <form action={action} className="col" style={{ gap: 14 }}>
      <div className="col" style={{ gap: 14 }}>
        {!fieldsHidden && view.descriptor.secretFields.map((field) => {
          const existing = configured.get(field.key);
          return (
            <Field
              key={field.key}
              name={field.key}
              type="password"
              label={field.label}
              placeholder={existing ? `configured · ends ${existing.last4}` : ''}
              help={
                existing
                  ? `${field.help ? `${field.help} ` : ''}Leave blank to keep the configured value.`
                  : field.help
              }
            />
          );
        })}
      </div>

      <p className="xs t3">{verification}</p>

      <div>
        <Submit
          label={label}
          busy="Testing…"
        />
      </div>

      <Outcome state={state} />
    </form>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 6 — Rate card
// ═════════════════════════════════════════════════════════════════════════════

export function RateCardForm() {
  const [state, action] = useActionState(confirmRateCard, IDLE);

  return (
    <form action={action} className="col" style={{ gap: 14 }}>
      <div>
        <Submit label="Check rates" busy="Checking…" />
      </div>
      <Outcome state={state} />
    </form>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 8 — First channel
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Step 8 when an active channel already exists (the seeded Bureau channel). Shows it, lets
 * the handle be edited, and completes the step without creating anything — the server
 * decides that, not this form (`completeChannelStep`).
 */
export function ExistingChannelForm({
  channel,
}: {
  channel: { name: string; platform: string; niche: string; handle: string | null; external_id: string | null };
}) {
  const [state, action] = useActionState(createChannel, IDLE);

  return (
    <form action={action} className="col" style={{ gap: 14 }}>
      <dl className="kv">
        <dt style={{ color: 'var(--t3)' }}>Channel</dt>
        <dd>{channel.name}</dd>
        <dt style={{ color: 'var(--t3)' }}>Platform</dt>
        <dd>{channel.platform}</dd>
        <dt style={{ color: 'var(--t3)' }}>Niche</dt>
        <dd>{channel.niche}</dd>
        <dt style={{ color: 'var(--t3)' }}>Channel ID</dt>
        <dd className="font-mono">{channel.external_id ?? '—'}</dd>
      </dl>
      <div style={{ maxWidth: 384 }}>
        <Field
          name="handle"
          label="Handle"
          defaultValue={channel.handle ?? ''}
          placeholder="@handle"
          help="Edit if it is wrong. Leave it as it is to keep it."
        />
      </div>
      <div>
        <Submit label="Use this channel" busy="Saving…" />
      </div>
      <Outcome state={state} />
    </form>
  );
}

export function ChannelForm() {
  const [state, action] = useActionState(createChannel, IDLE);

  return (
    <form action={action} className="col" style={{ gap: 14 }}>
      <div className="kgrid ga-220">
        <Field name="name" label="Channel name" required placeholder="Kiln — main" />
        <Field name="platform" label="Platform" required placeholder="youtube" />
        <Field
          name="niche"
          label="Niche"
          required
          placeholder="ai-tooling"
          help="A row, not a decision in code — keep it reversible."
        />
        <Field name="handle" label="Handle" placeholder="@kiln" />
      </div>
      <div>
        <Submit label="Create channel" busy="Creating…" />
      </div>
      <Outcome state={state} />
    </form>
  );
}
