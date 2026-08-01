"use server";

import { redirect } from "next/navigation";

import { checkEmail, SIGN_IN_REFUSED } from "@/lib/auth/allowed";
import { routeClient } from "@/lib/auth/supabase";

export interface SignInState {
  status: "idle" | "sent" | "refused" | "error";
  message?: string;
}

/**
 * Request a sign-in link.
 *
 * Magic link rather than a password: the only account is the operator's, and a password
 * here would be one more secret to store badly for no gain in security over an address
 * that already gates the workspace.
 *
 * The allowlist is checked *before* the link is requested, so a stranger's address never
 * reaches Supabase and no account is created for it. That is belt and braces — middleware
 * would refuse the resulting session anyway — but a Supabase project accumulating rows in
 * auth.users for everyone who typed their address into a public preview URL is its own
 * small problem.
 *
 * The refusal message does not say which of "not configured" and "not the permitted
 * address" happened, and does not confirm whether an account exists. Neither fact helps
 * the person who is allowed to sign in.
 */
export async function requestSignInLink(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "");

  const decision = checkEmail(email);
  if (!decision.ok) {
    return { status: "refused", message: SIGN_IN_REFUSED };
  }

  const next = String(formData.get("next") ?? "/");
  // Only same-origin paths. A `next` taken from the query string and pasted into a
  // redirect URL is an open redirect, and this one would arrive attached to a sign-in
  // link — the most convincing possible place to put one.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const origin = process.env.APP_URL;
  if (!origin) {
    return {
      status: "error",
      message:
        "APP_URL is not set, so there is no address to send you back to. The sign-in " +
        "link would point at nothing.",
    };
  }

  const supabase = await routeClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: decision.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      // No self-signup. The one permitted account is created deliberately, once, in the
      // Supabase dashboard — not by whoever first loads the preview URL.
      shouldCreateUser: false,
    },
  });

  if (error) {
    return { status: "error", message: error.message };
  }

  return { status: "sent" };
}

/**
 * Sign in with Google.
 *
 * Added because the magic-link path has a hard external dependency this project cannot
 * satisfy yet: Supabase's built-in mailer rate-limits to a handful of sends an hour, and
 * custom SMTP needs a domain. That turns every auth test into an hour's wait, which is a
 * poor foundation for a gate that has to be tested repeatedly.
 *
 * It sits *alongside* the link flow rather than replacing it. When a domain exists, custom
 * SMTP makes magic links viable again, and an operator whose Google account is unavailable
 * should still have a way in. Two doors, one lock — both land on `/auth/callback` and both
 * are refused by the same allowlist check.
 *
 * ── No allowlist check here, and that is deliberate ──────────────────────────
 *
 * `requestSignInLink` checks before sending, because sending a link creates something
 * durable in a stranger's inbox. Nothing durable is created here — the redirect goes to
 * Google, and the check happens when they come back. Checking first would also be
 * *useless*: the address is not known until Google says what it is, and refusing based on
 * whatever someone typed into a form proves nothing about who they sign in as.
 *
 * The consequence is that a stranger can complete a Google sign-in and be refused at the
 * callback. That is the correct shape — see the note there about destroying the session
 * the exchange creates.
 */
export async function signInWithGoogle(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const next = String(formData.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const origin = process.env.APP_URL;
  if (!origin) {
    return {
      status: "error",
      message:
        "APP_URL is not set, so there is no address for Google to return you to.",
    };
  }

  const supabase = await routeClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      queryParams: {
        // Ask for the account chooser every time. Without it Google silently reuses the
        // last account, which on a shared machine signs you in as someone else and looks
        // like the allowlist misbehaving.
        prompt: "select_account",
      },
    },
  });

  if (error) return { status: "error", message: error.message };
  if (!data.url)
    return {
      status: "error",
      message: "Google returned no authorisation URL.",
    };

  // A Server Action cannot return a redirect as data; `redirect()` throws a control-flow
  // signal that Next turns into the response.
  redirect(data.url);
}
