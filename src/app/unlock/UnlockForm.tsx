"use client";
import { useActionState } from "react";
import { unlockAction } from "@/app/actions/unlock";

export function UnlockForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(unlockAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label className="label" htmlFor="pin">Access PIN</label>
        <input
          id="pin"
          className="input"
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{8}"
          maxLength={8}
          placeholder="8-digit PIN"
          required
          autoFocus
        />
      </div>
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Checking…" : "View receipts"}
        </button>
        {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
