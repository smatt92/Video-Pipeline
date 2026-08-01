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
      className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
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

function GoogleButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full items-center justify-center gap-2 rounded-sm border px-3 py-[8px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
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

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(requestSignInLink, initial);
  const [googleState, googleAction] = useActionState(signInWithGoogle, initial);

  if (state.status === "sent") {
    return (
      <p
        className="text-[13px] leading-relaxed"
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
          not cost an hour per attempt when the built-in mailer rate-limits. */}
      <form action={googleAction}>
        <input type="hidden" name="next" value={next} />
        <GoogleButton />
      </form>

      {googleState.message && (
        <p
          className="text-[12px] leading-relaxed"
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
          className="font-mono text-[10px] uppercase"
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
            className="font-mono text-[10px] uppercase tracking-[0.09em]"
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
            className="w-full rounded-sm border px-[10px] py-[7px] text-[13px] outline-none"
            style={{
              background: "var(--surface-inset)",
              borderColor: "var(--border-subtle)",
              color: "var(--text-primary)",
            }}
          />
        </label>

        {state.message && (
          <p
            className="text-[12px] leading-relaxed"
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
        className="text-[11px] leading-relaxed"
        style={{ color: "var(--text-faint)" }}
      >
        Either way the address has to be on the allowlist. Google authenticating
        you is not the same as this workspace admitting you.
      </p>
    </div>
  );
}
