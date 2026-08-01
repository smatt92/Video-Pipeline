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
      className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: 'var(--accent)',
        color: 'var(--accent-contrast)',
        transitionDuration: 'var(--duration-fast)',
      }}
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
    <label className="flex flex-col gap-[5px]">
      <span
        className="font-mono text-[10px] uppercase tracking-[0.09em]"
        style={{ color: 'var(--text-faint)' }}
      >
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
        className="w-full rounded-sm border px-[10px] py-[7px] text-[13px] outline-none"
        style={{
          background: 'var(--surface-inset)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      />
      {help && (
        <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {help}
        </span>
      )}
    </label>
  );
}

/** Result of the last submit. Required failures read as errors; informational ones do not. */
function Outcome({ state }: { state: StepState }) {
  if (state.status === 'idle') return null;

  const tone = state.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)';

  return (
    <div className="flex flex-col gap-2">
      {state.message && (
        <p
          className="text-[12px] leading-relaxed whitespace-pre-line"
          style={{ color: tone }}
        >
          {state.message}
        </p>
      )}

      {state.checks && state.checks.length > 0 && (
        <ul className="flex flex-col gap-[6px]">
          {state.checks.map((c) => (
            <li key={c.name} className="flex gap-2 text-[11.5px] leading-relaxed">
              <span
                aria-hidden
                className="mt-[5px] size-[7px] shrink-0 rounded-full"
                style={{
                  background: c.passed
                    ? 'var(--state-live)'
                    : c.required
                      ? 'var(--state-blocked)'
                      : 'var(--state-drafting)',
                }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>
                <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
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

export function ProfileForm({ email }: { email: string | null }) {
  const [state, action] = useActionState(saveProfile, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="display_name" label="Display name" placeholder="Sahil" />
        <Field name="timezone" label="Timezone" defaultValue="Asia/Kolkata" />
        <Field name="currency" label="Currency" defaultValue="INR" />
        <Field
          name="usd_inr_rate"
          label="USD → INR"
          placeholder="88.5"
          help="Every rupee figure derives from this. Snapshotted onto each cost row, so changing it later does not rewrite history."
        />
      </div>
      {email && (
        <p className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          Signed in as {email}. The profile is written against this account.
        </p>
      )}
      <div>
        <Submit label="Save profile" busy="Saving…" />
      </div>
      <Outcome state={state} />
    </form>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Steps 2–5 — credentials, then a real call
// ═════════════════════════════════════════════════════════════════════════════

export function IntegrationStepForm({
  stepNumber,
  view,
  verification,
}: {
  stepNumber: number;
  view: StepIntegrationView;
  verification: string;
}) {
  const [state, action] = useActionState(runStepCheck.bind(null, stepNumber), IDLE);

  const configured = new Map(view.secrets.map((s) => [s.fieldKey, s]));

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        {view.descriptor.secretFields.map((field) => {
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

      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        {verification}
      </p>

      <div>
        <Submit
          label={view.secrets.length ? 'Save and run check' : 'Save and run check'}
          busy="Calling the vendor…"
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
    <form action={action} className="flex flex-col gap-4">
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

export function ChannelForm() {
  const [state, action] = useActionState(createChannel, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
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
