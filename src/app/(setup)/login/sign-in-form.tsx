"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  requestSignInLink,
  signInWithGoogle,
  type SignInState,
} from "./actions";

const initial: SignInState = { status: "idle" };

/*
 * Presentation per the canvas sign-in splash (BrandApplied). The mechanism is unchanged:
 * Google first, then the emailed link, and either way the allowlist decides. The canvas shows
 * "Sign in with passkey"; this workspace has no passkey sign-in, so that button is not drawn —
 * a control for a mechanism that does not exist is a promise the page cannot keep.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn lg full">
      {pending ? "Sending…" : "Send sign-in link"}
    </button>
  );
}

function GoogleButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className="btn pri lg full">
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
  googleState: "enabled" | "disabled" | "unknown";
  googleDetail: string | null;
}) {
  const [state, action] = useActionState(requestSignInLink, initial);
  const [googleState, googleAction] = useActionState(signInWithGoogle, initial);

  if (state.status === "sent") {
    return (
      <p className="splash-msg" role="status">
        Link sent. It signs you in on this device and expires shortly — request another if it lapses.
      </p>
    );
  }

  return (
    <div className="splash-card">
      {/* Rendered even when it cannot be used: a disabled control with a reason is
          diagnosable; an absent one looks like a deployment that never shipped it. */}
      <form action={googleAction}>
        <input type="hidden" name="next" value={next} />
        <GoogleButton disabled={providerState === "disabled"} />
      </form>

      {googleDetail && (
        <p className={`splash-msg ${providerState === "disabled" ? "err" : "warn"}`}>
          {providerState === "unknown" && "Cannot tell whether Google is enabled. "}
          {googleDetail}
        </p>
      )}

      {googleState.message && (
        <p className="splash-msg err" role="alert">
          {googleState.message}
        </p>
      )}

      <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
        <span style={{ height: 1, flex: 1, background: "var(--b2)" }} />
        <span className="mono xs splash-or">or</span>
        <span style={{ height: 1, flex: 1, background: "var(--b2)" }} />
      </div>

      <form action={action} className="col" style={{ gap: 10 }}>
        <input type="hidden" name="next" value={next} />
        <div className="field">
          <label htmlFor="signin-email" className="chalk-2">Email</label>
          <input id="signin-email" name="email" type="email" required autoComplete="email" className="input" />
        </div>
        {state.message && (
          <p className="splash-msg err" role="alert">
            {state.message}
          </p>
        )}
        <Submit />
      </form>

      <p className="xs chalk-3">
        Either way the address has to be on the allowlist. Google authenticating you is not the same as this
        workspace admitting you.
      </p>
    </div>
  );
}
