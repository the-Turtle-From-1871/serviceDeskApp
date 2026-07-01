"use client";
import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "@/app/actions/auth";
import { RANK_OPTIONS } from "@/lib/ranks";

export default function RegisterPage() {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 420 }}>
        <div className="stack-sm">
          <div className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Create your account</h1>
          <p className="subtle">Register to hold and sign for items.</p>
        </div>
        <form action={action} className="stack">
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="rank">Rank</label>
              <input id="rank" className="input" name="rank" list="ranks" placeholder="e.g. SGT (optional)" autoComplete="off" />
              <datalist id="ranks">
                {RANK_OPTIONS.map((r) => <option key={r} value={r} />)}
              </datalist>
            </div>
            <div className="field">
              <label className="label" htmlFor="name">Full name<span className="req"> *</span></label>
              <input id="name" className="input" name="name" required autoComplete="name" />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="email">Email<span className="req"> *</span></label>
            <input id="email" className="input" name="email" type="email" required autoComplete="email" />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password<span className="req"> *</span></label>
            <input id="password" className="input" name="password" type="password" required minLength={8} autoComplete="new-password" />
            <span className="hint">At least 8 characters.</span>
          </div>
          {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
          <button disabled={pending} type="submit" className="btn btn-primary btn-block">
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="subtle" style={{ textAlign: "center" }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
