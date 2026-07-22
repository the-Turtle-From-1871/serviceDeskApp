"use client";
import { useActionState } from "react";
import { setPublicAccessPinAction } from "@/app/admin/actions/public-access";

export function PublicAccessPinForm() {
  const [state, action, pending] = useActionState(setPublicAccessPinAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="pa-pin">New 8-digit PIN</label>
          <input
            id="pa-pin"
            className="input"
            name="pin"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{8}"
            maxLength={8}
            placeholder="8 digits"
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pa-confirm">Confirm PIN</label>
          <input
            id="pa-confirm"
            className="input"
            name="confirm"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{8}"
            maxLength={8}
            placeholder="re-enter"
            required
          />
        </div>
      </div>
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Set PIN"}
        </button>
        {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
        {state && "ok" in state && state.ok && <span className="alert-success">PIN updated.</span>}
      </div>
    </form>
  );
}
