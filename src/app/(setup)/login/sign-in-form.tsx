"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  requestSignInLink,
  signInWithGoogle,
  type SignInState,
} from "./actions";

const initial: SignInState = { status: "idle" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm px-3 py-[7px] text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: "var(--accent)",
        color: "var(--accent-contrast)",
        transitionDuration: "var(--duration-fast)",
      }}
    >
      {pending ? "Sending…" : "Send sign-in link"}
    </button>
  );
}

function GoogleButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="flex w-full items-center justify-center gap-2 rounded-sm border px-3 py-[8px] text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        borderColor: "var(--border-default)",
        color: "var(--text-primary)",
        transitionDuration: "var(--duration-fast)",
      }}
    >
      {pending ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}

export function SignInForm({
  next,
  googleState: providerState,
  googleDetail,
}: {
  next: string;
  /** enabled | disabled | unknown. Never hidden — see the note on the form below. */
  googleState: "enabled" | "disabled" | "unknown";
  googleDetail: string | null;
}) {
  const [state, action] = useActionState(requestSignInLink, initial);
  const [googleState, googleAction] = useActionState(signInWithGoogle, initial);

  if (state.status === "sent") {
    return (
      <p
        className="text-sm leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        Link sent. It signs you in on this device and expires shortly — request
        another if it lapses.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Google first: it is the path that works without a domain, and the one that does
          not cost an hour per attempt when the built-in mailer rate-limits.

          Rendered even when it cannot be used. A disabled control with a reason is
          diagnosable; an absent one is indistinguishable from a deployment that never
          shipped it — which is exactly the ambiguity this replaced. */}
      <form action={googleAction}>
        <input type="hidden" name="next" value={next} />
        <GoogleButton disabled={providerState === "disabled"} />
      </form>

      {googleDetail && (
        <p
          className="text-xs leading-relaxed"
          style={{
            color:
              providerState === "disabled"
                ? "var(--state-blocked)"
                : "var(--state-review)",
          }}
        >
          {providerState === "unknown" &&
            "Cannot tell whether Google is enabled. "}
          {googleDetail}
        </p>
      )}

      {googleState.message && (
        <p
          className="text-xs leading-relaxed"
          style={{ color: "var(--state-blocked)" }}
        >
          {googleState.message}
        </p>
      )}

      <div className="flex items-center gap-3">
        <span
          className="h-px flex-1"
          style={{ background: "var(--border-subtle)" }}
        />
        <span
          className="font-mono text-3xs uppercase"
          style={{ color: "var(--text-faint)" }}
        >
          or
        </span>
        <span
          className="h-px flex-1"
          style={{ background: "var(--border-subtle)" }}
        />
      </div>

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-[6px]">
          <span
            className="font-mono text-3xs uppercase tracking-[0.09em]"
            style={{ color: "var(--text-faint)" }}
          >
            Email
          </span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            className="w-full rounded-sm border px-[10px] py-[7px] text-sm outline-none"
            style={{
              background: "var(--surface-inset)",
              borderColor: "var(--border-subtle)",
              color: "var(--text-primary)",
            }}
          />
        </label>

        {state.message && (
          <p
            className="text-xs leading-relaxed"
            style={{ color: "var(--state-blocked)" }}
          >
            {state.message}
          </p>
        )}

        <div>
          <Submit />
        </div>
      </form>

      <p
        className="text-2xs leading-relaxed"
        style={{ color: "var(--text-faint)" }}
      >
        Either way the address has to be on the allowlist. Google authenticating
        you is not the same as this workspace admitting you.
      </p>
    </div>
  );
}
