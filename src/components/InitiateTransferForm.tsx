"use client";
import { useActionState } from "react";
import { initiateTransferAction } from "@/app/actions/transfers";
import { UserCombobox } from "@/components/UserCombobox";

type UserOption = { id: string; name: string; rank?: string | null };

function toOptions(users: UserOption[]) {
  return users.map((u) => ({ id: u.id, label: u.rank ? `${u.rank} ${u.name}` : u.name }));
}

export function InitiateTransferForm({ itemId, users }: { itemId: string; users: UserOption[] }) {
  const [state, action, pending] = useActionState(initiateTransferAction, undefined);
  if (state && "ok" in state && state.ok)
    return <p className="alert-success">Transfer started. The recipient must sign to accept custody.</p>;
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="field">
        <label className="label">Transfer to</label>
        <UserCombobox name="toUserId" users={toOptions(users)} required />
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
