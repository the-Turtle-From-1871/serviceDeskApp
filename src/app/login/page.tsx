"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
        <Link href="/" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}>← Back to search</Link>
        <div className="stack-sm">
          <div className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Sign in</h1>
          <p className="subtle">Sign in to log items and create hand receipts.</p>
        </div>
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
      </div>
    </div>
  );
}
