"use client";
import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/account";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  const done = !!(state && "ok" in state && state.ok);

  if (done) {
    return <p className="alert-success">Your password has been changed. It takes effect the next time you sign in.</p>;
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
