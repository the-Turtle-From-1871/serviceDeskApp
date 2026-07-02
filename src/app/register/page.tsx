"use client";
import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "@/app/actions/auth";

export default function RegisterPage() {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 420 }}>
        <div className="stack-sm">
          <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Create account</h1>
          <p className="subtle">For transfers between two non-DCSIM parties. Your details appear on receipts you send.</p>
        </div>
        <form action={action} className="stack">
          <div className="form-grid">
            <div className="field"><label className="label" htmlFor="r-rank">Rank</label><input id="r-rank" className="input" name="rank" placeholder="e.g. SGT (optional)" autoComplete="off" /></div>
            <div className="field"><label className="label" htmlFor="r-name">Name</label><input id="r-name" className="input" name="name" required /></div>
            <div className="field"><label className="label" htmlFor="r-unit">Unit</label><input id="r-unit" className="input" name="unit" placeholder="e.g. A Co, 1-1 IN" /></div>
            <div className="field"><label className="label" htmlFor="r-contact">Contact number</label><input id="r-contact" className="input" name="contactNumber" /></div>
            <div className="field"><label className="label" htmlFor="r-email">Email</label><input id="r-email" className="input" name="email" type="email" required autoComplete="email" /></div>
            <div className="field"><label className="label" htmlFor="r-pw">Password</label><input id="r-pw" className="input" name="password" type="password" placeholder="8+ characters" required autoComplete="new-password" /></div>
          </div>
          {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
          <button disabled={pending} type="submit" className="btn btn-primary btn-block">{pending ? "Creating…" : "Create account"}</button>
          <p className="subtle">Already have an account? <Link href="/login">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
