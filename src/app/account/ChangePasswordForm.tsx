"use client";
import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/account";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  const done = !!(state && "ok" in state && state.ok);

  // Normally unreachable: a successful change revokes every existing session
  // (including this one) and changePasswordAction redirects to /login. Kept as
  // an honest fallback in case the redirect does not happen — the message must
  // not claim the old session is still good, because it is not.
  if (done) {
    return <p className="alert-success">Your password has been changed. Sign in again with your new password.</p>;
  }

  return (
    <form action={action} className="stack">
      <div className="field">
        <label className="label" htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" className="input" name="currentPassword" type="password" required autoComplete="current-password" />
      </div>
      <div className="field">
        <label className="label" htmlFor="newPassword">New password</label>
        <input id="newPassword" className="input" name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      <div className="field">
        <label className="label" htmlFor="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" className="input" name="confirmPassword" type="password" required autoComplete="new-password" />
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <div>
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
