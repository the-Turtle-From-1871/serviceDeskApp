"use client";
import { useActionState } from "react";
import { overrideAssignAction } from "@/app/admin/actions/override";

export function OverrideForm({ itemId, users }: { itemId: string; users: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(overrideAssignAction, undefined);
  if (state && "ok" in state && state.ok) return <p>Item reassigned (override recorded).</p>;
  return (
    <form action={action}>
      <input type="hidden" name="itemId" value={itemId} />
      <select name="toUserId" required>
        <option value="">Reassign to…</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      {state?.error && <span role="alert" style={{ color: "crimson" }}> {state.error}</span>}
      <button disabled={pending} type="submit">Force reassign</button>
    </form>
  );
}
