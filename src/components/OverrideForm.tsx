"use client";
import { useActionState } from "react";
import { overrideAssignAction } from "@/app/admin/actions/override";

export function OverrideForm({ itemId, users }: { itemId: string; users: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(overrideAssignAction, undefined);
  if (state && "ok" in state && state.ok)
    return <p className="alert-success">Item reassigned (override recorded).</p>;
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="field">
        <label className="label" htmlFor="ov-toUserId">Reassign to</label>
        <select id="ov-toUserId" className="select" name="toUserId" required>
          <option value="">Select a person…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <div>
        <button disabled={pending} type="submit" className="btn btn-danger">
          {pending ? "Reassigning…" : "Force reassign"}
        </button>
      </div>
    </form>
  );
}
