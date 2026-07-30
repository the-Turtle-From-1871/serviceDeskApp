"use client";
import Link from "next/link";
import { useActionState, useState, useSyncExternalStore } from "react";
import { loginAction } from "@/app/actions/auth";
import { TurnstileWidget, type TurnstileStatus } from "@/components/TurnstileWidget";

// The interactive part of /login. Split out so the page shell (brand, headings)
// stays a Server Component instead of shipping as client JS.
//
// `turnstileSiteKey` is resolved by the page (a Server Component) and is null
// when Turnstile is not configured, so the decision to challenge is made on the
// server rather than from a `NEXT_PUBLIC_` read in the browser. The server
// action verifies independently either way — a client that skips the widget
// gains nothing.
export function LoginForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [state, action, pending] = useActionState(loginAction, undefined);
  // `ready` when there is no challenge to wait for, so the button behaves
  // exactly as it did before Turnstile existed.
  const [challenge, setChallenge] = useState<TurnstileStatus>(
    turnstileSiteKey ? "pending" : "ready",
  );

  // Held until Cloudflare answers. Filling in an email and password takes a
  // second or two, and submitting first sends a tokenless form — which the
  // server correctly refuses with "could not verify that request came from a
  // browser", for a completely valid login. An `error` state still submits: the
  // challenge could not run at all, and a button that can never be pressed is
  // worse than a refusal that says something.
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

  return (
    <form action={action} className="stack">
      <div className="field">
        <label className="label" htmlFor="email">Email</label>
        <input id="email" className="input" name="email" type="email" required autoComplete="email" />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" name="password" type="password" required autoComplete="current-password" />
        <Link href="/forgot-password" className="subtle" style={{ fontSize: 13, marginTop: 6, display: "inline-block" }}>Forgot password?</Link>
      </div>
      {/* `resetOn={state}` replaces the spent challenge after a rejected
          attempt — a token is single-use, so without it the second sign-in try
          would be refused for a reason the user cannot see. */}
      {turnstileSiteKey && (
        <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} onStatus={setChallenge} />
      )}
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <button disabled={pending || waiting} type="submit" className="btn btn-primary btn-block">
        {pending ? "Signing in…" : waiting ? "Checking your browser…" : "Sign in"}
      </button>
    </form>
  );
}
