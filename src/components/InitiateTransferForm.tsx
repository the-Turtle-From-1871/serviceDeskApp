"use client";
import { useActionState } from "react";
import { initiateTransferAction } from "@/app/actions/transfers";

type UserOption = { id: string; name: string };
export function InitiateTransferForm({ itemId, users }: { itemId: string; users: UserOption[] }) {
  const [state, action, pending] = useActionState(initiateTransferAction, undefined);
  if (state && "ok" in state && state.ok) return <p>Transfer started. The recipient must sign to accept.</p>;
  return (
    <form action={action}>
      <input type="hidden" name="itemId" value={itemId} />
      <label>Transfer to:{" "}
        <select name="toUserId" required>
          <option value="">Select a person…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
      {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
      <button disabled={pending} type="submit">{pending ? "Starting…" : "Initiate transfer"}</button>
    </form>
  );
}
