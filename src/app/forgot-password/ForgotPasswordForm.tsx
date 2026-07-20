"use client";
import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordResetAction } from "@/app/actions/auth";

// The interactive part of /forgot-password — it switches between the form and a
// "check your email" confirmation based on the action result, so it owns both
// views. The page shell around it stays a Server Component.
export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, undefined);

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
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        <button disabled={pending} type="submit" className="btn btn-primary btn-block">{pending ? "Sending…" : "Send reset link"}</button>
      </form>
    </>
  );
}
