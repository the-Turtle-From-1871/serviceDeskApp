"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";

// The interactive part of /login. Split out so the page shell (brand, headings)
// stays a Server Component instead of shipping as client JS.
export function LoginForm() {
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
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <button disabled={pending} type="submit" className="btn btn-primary btn-block">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
