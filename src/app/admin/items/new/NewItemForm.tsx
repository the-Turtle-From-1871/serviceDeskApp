"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";

type UserOption = { id: string; name: string };

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["assetTag", "Asset tag", false],
  ["homeLocation", "Home location", false],
] as const;

export function NewItemForm({ users }: { users: UserOption[] }) {
  const [state, action, pending] = useActionState(createItemAction, undefined);

  if (state && "itemId" in state && state.itemId) {
    return (
      <div className="card stack">
        <p className="alert-success">Item created successfully.</p>
        <div className="row">
          <Link href={`/admin/items/${state.itemId}/qr`} className="btn btn-primary">View / print QR code →</Link>
          <Link href="/admin/items/new" className="btn btn-secondary">Add another</Link>
          <Link href="/admin/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="card stack">
      <div className="form-grid">
        {fields.map(([name, label, req]) => (
          <div className="field" key={name}>
            <label className="label" htmlFor={name}>
              {label}{req && <span className="req"> *</span>}
            </label>
            <input id={name} className="input" name={name} required={req} />
          </div>
        ))}
        <div className="field">
          <label className="label" htmlFor="initialHolderId">Initial holder</label>
          <select id="initialHolderId" name="initialHolderId" className="select">
            <option value="">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="field col-span-2">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea id="notes" className="textarea" name="notes" placeholder="Optional details about this item" />
        </div>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Create item"}
        </button>
        <Link href="/admin/items" className="btn btn-ghost">Cancel</Link>
      </div>
    </form>
  );
}
