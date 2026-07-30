"use client";
import Link from "next/link";
import { useActionState, useState, useSyncExternalStore } from "react";
import { requestPasswordResetAction } from "@/app/actions/auth";
import { TurnstileWidget, type TurnstileStatus } from "@/components/TurnstileWidget";

// The interactive part of /forgot-password — it switches between the form and a
// "check your email" confirmation based on the action result, so it owns both
// views. The page shell around it stays a Server Component.
//
// `turnstileSiteKey` is null when Turnstile is not configured; see LoginForm
// for why the page resolves it server-side.
export function ForgotPasswordForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [state, action, pending] = useActionState(requestPasswordResetAction, undefined);
  // See LoginForm for why the button waits: submitting before Cloudflare
  // answers sends a tokenless form and is refused, for a valid request.
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

  if (state && "ok" in state) {
    return (
      <>
        <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
        <h1 className="page-title" style={{ fontSize: 20 }}>Check your email</h1>
        <p className="subtle">If an account exists for that email, we&rsquo;ve sent a link to reset your password. It expires in 1 hour.</p>
        <Link href="/login" className="btn btn-primary btn-block">Back to sign in</Link>
      </>
    );
  }

  return (
    <>
      <Link href="/login" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}>← Back to sign in</Link>
      <div className="stack-sm">
        <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
        <h1 className="page-title" style={{ fontSize: 20 }}>Forgot password</h1>
        <p className="subtle">Enter your account email and we&rsquo;ll send you a reset link.</p>
      </div>
      <form action={action} className="stack">
        <div className="field">
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" name="email" type="email" required autoComplete="email" />
        </div>
        {turnstileSiteKey && (
          <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} onStatus={setChallenge} />
        )}
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        <button disabled={pending || waiting} type="submit" className="btn btn-primary btn-block">
          {pending ? "Sending…" : waiting ? "Checking your browser…" : "Send reset link"}
        </button>
      </form>
    </>
  );
}
