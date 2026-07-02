"use client";
import { useActionState } from "react";
import Link from "next/link";
import { updateItemAction } from "@/app/admin/actions/items";

type ItemValues = {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
  homeUnit: string | null;
  notes: string | null;
};

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["homeUnit", "Home unit", false],
] as const;

export function EditItemForm({ item }: { item: ItemValues }) {
  const [state, action, pending] = useActionState(updateItemAction, undefined);
  const saved = !!(state && "ok" in state && state.ok);

  return (
    <form action={action} className="card stack">
      <input type="hidden" name="id" value={item.id} />
      <div className="form-grid">
        {fields.map(([name, label, req]) => (
          <div className="field" key={name}>
            <label className="label" htmlFor={name}>
              {label}{req && <span className="req"> *</span>}
            </label>
            <input
              id={name}
              className="input"
              name={name}
              required={req}
              defaultValue={item[name] ?? ""}
            />
          </div>
        ))}
        <div className="field col-span-2">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea id="notes" className="textarea" name="notes" defaultValue={item.notes ?? ""} />
        </div>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      {saved && <p className="alert-success">Changes saved.</p>}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Save changes"}
        </button>
        <Link href="/admin/items" className="btn btn-ghost">Back to items</Link>
      </div>
    </form>
  );
}
