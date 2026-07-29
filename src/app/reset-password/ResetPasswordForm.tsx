"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { resetPasswordAction } from "@/app/actions/auth";
import { TurnstileWidget, type TurnstileStatus } from "@/components/TurnstileWidget";

export function ResetPasswordForm({
  token,
  turnstileSiteKey,
}: {
  token: string;
  turnstileSiteKey: string | null;
}) {
  const [state, action, pending] = useActionState(resetPasswordAction, undefined);
  // Same hold as the other two auth forms — see LoginForm. This surface got the
  // challenge last, even though it is the one where a correct guess is an
  // outright account takeover rather than a step towards one.
  const [challenge, setChallenge] = useState<TurnstileStatus>(
    turnstileSiteKey ? "pending" : "ready",
  );
  const waiting = challenge === "pending";

  // Scrub the raw token from the address bar / browser history on mount.
  // The token lives in the hidden input (from the prop), so stripping the
  // query param here does not affect form submission. No-op when there is
  // nothing to strip.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.search.includes("token=")) return;
    window.history.replaceState(null, "", "/reset-password");
  }, []);

  if (state && "ok" in state) {
    return (
      <div className="stack">
        <p role="status" className="subtle">Your password has been reset. You can now sign in with your new password.</p>
        <Link href="/login" className="btn btn-primary btn-block">Go to sign in</Link>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <input type="hidden" name="token" value={token} />
      <div className="field">
        <label className="label" htmlFor="password">New password</label>
        <input id="password" className="input" name="password" type="password" placeholder="8+ characters" required autoComplete="new-password" />
      </div>
      <div className="field">
        <label className="label" htmlFor="confirm">Confirm password</label>
        <input id="confirm" className="input" name="confirm" type="password" required autoComplete="new-password" />
      </div>
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
      {turnstileSiteKey && (
        <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} onStatus={setChallenge} />
      )}
      <button disabled={pending || waiting} type="submit" className="btn btn-primary btn-block">
        {pending ? "Saving…" : waiting ? "Checking your browser…" : "Reset password"}
      </button>
    </form>
  );
}
