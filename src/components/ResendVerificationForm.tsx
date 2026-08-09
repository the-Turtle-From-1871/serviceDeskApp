"use client";
import { useActionState } from "react";
import { resendVerificationAction } from "@/app/actions/auth";

/**
 * Re-sends the confirmation link. Used from two places — the sign-in page when
 * an unconfirmed account tries to log in, and the verify-email page when a link
 * has expired — so it lives here rather than being written twice.
 *
 * The success message is deliberately the same regardless of whether the
 * address exists, is already confirmed, or was never registered: the action
 * itself is generic for anti-enumeration reasons, and a UI that said "no such
 * account" would give away exactly what the action refuses to.
 */
export function ResendVerificationForm({ email = "" }: { email?: string }) {
  const [state, action, pending] = useActionState(resendVerificationAction, undefined);
  const sent = !!(state && "ok" in state && state.ok);

  if (sent) {
    return (
      <p className="alert-success" role="status">
        If that address needs confirming, a new link is on its way. It expires in 24 hours.
      </p>
    );
  }

  return (
    <form action={action} className="stack-sm">
      {email ? (
        <input type="hidden" name="email" value={email} />
      ) : (
        <div className="field">
          <label className="label" htmlFor="resend-email">Email</label>
          <input
            id="resend-email"
            className="input"
            name="email"
            type="email"
            required
            autoComplete="username"
          />
        </div>
      )}
      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}
      <button disabled={pending} type="submit" className="btn btn-secondary">
        {pending ? "Sending…" : "Resend the confirmation link"}
      </button>
    </form>
  );
}
