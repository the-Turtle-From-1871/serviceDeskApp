"use client";
import { useActionState } from "react";
import { initiateTransferAction } from "@/app/actions/transfers";

type UserOption = { id: string; name: string };
export function InitiateTransferForm({ itemId, users }: { itemId: string; users: UserOption[] }) {
  const [state, action, pending] = useActionState(initiateTransferAction, undefined);
  if (state && "ok" in state && state.ok)
    return <p className="alert-success">Transfer started. The recipient must sign to accept custody.</p>;
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="field">
        <label className="label" htmlFor="toUserId">Transfer to</label>
        <select id="toUserId" className="select" name="toUserId" required>
          <option value="">Select a person…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <div>
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Starting…" : "Initiate transfer"}
        </button>
      </div>
    </form>
  );
}
