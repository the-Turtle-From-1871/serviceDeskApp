"use client";
import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordAction } from "@/app/actions/auth";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, undefined);

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
      <button disabled={pending} type="submit" className="btn btn-primary btn-block">{pending ? "Saving…" : "Reset password"}</button>
    </form>
  );
}
