"use client";
import { useActionState } from "react";
import { updateItemIdentityAction } from "@/app/admin/actions/items";

// The identity-correction form: make / model / serialNumber, exactly the fields
// `itemIdentitySchema` declares.
//
// A SEPARATE card and a SEPARATE submit from the main seven-field form on
// purpose. These three are what a device IS — the serial in particular is the
// identity signed hand receipts name — so correcting one should read as a
// deliberate act, not something tabbed through on the way to editing a phone
// number. This form exists ONLY on the admin edit page; the item detail card
// cannot reach these fields at all.
type IdentityValues = {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
};

const fields = [
  ["make", "Make"],
  ["model", "Model"],
  ["serialNumber", "Serial number"],
] as const;

export function EditItemIdentityForm({ item }: { item: IdentityValues }) {
  const [state, action, pending] = useActionState(updateItemIdentityAction, undefined);
  const saved = !!(state && "ok" in state && state.ok);

  return (
    <form action={action} className="card stack">
      <div>
        <div className="card__title">Item identity</div>
        <p className="subtle">
          Make, model and serial number are normally set when an item is created
          or imported. Correct them here when the record itself is wrong.
        </p>
      </div>
      <input type="hidden" name="id" value={item.id} />
      <div className="form-grid">
        {fields.map(([name, label]) => (
          <div className="field" key={name}>
            <label className="label" htmlFor={`identity-${name}`}>
              {label}<span className="req"> *</span>
            </label>
            <input
              id={`identity-${name}`}
              className="input"
              name={name}
              required
              defaultValue={item[name]}
            />
          </div>
        ))}
      </div>
      <p className="alert-warning">
        A serial number is the identity existing signed hand receipts refer to,
        so correcting one changes what those receipts appear to describe.
      </p>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      {saved && <p className="alert-success">Item identity updated.</p>}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-secondary">
          {pending ? "Saving…" : "Save identity"}
        </button>
      </div>
    </form>
  );
}
