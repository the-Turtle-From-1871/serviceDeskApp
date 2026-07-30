"use client";
import Link from "next/link";
import { useActionState, useEffect, useState, useSyncExternalStore } from "react";
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
  // `hydrated` is what keeps the SERVER-rendered button enabled.
  //
  // Deriving `waiting` from the challenge alone put `<button disabled>` in the
  // initial HTML, so any failure that stops the client bundle running — a
  // content filter, a parse error, a throw before the widget's effects — left
  // an inert form with no message and no way to sign in, because the 15-second
  // release lives in that same JS. It also defeated React's progressive
  // enhancement, which would otherwise POST the form action natively.
  //
  // Enabled until proven otherwise: if JS never runs the form still submits and
  // the server refuses it with something readable.
  // `useSyncExternalStore` rather than a state-setting effect: it returns the
  // server snapshot (false) during SSR and the client one (true) once mounted,
  // with no cascading render — which is what the lint rule about setState in an
  // effect is there to prevent.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const waiting = hydrated && challenge === "pending";

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
