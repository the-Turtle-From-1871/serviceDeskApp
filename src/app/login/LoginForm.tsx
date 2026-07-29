"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";
import { TurnstileWidget } from "@/components/TurnstileWidget";

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
      {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />}
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <button disabled={pending} type="submit" className="btn btn-primary btn-block">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
