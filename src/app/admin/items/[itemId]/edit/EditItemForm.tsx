"use client";
import { useActionState } from "react";
import Link from "next/link";
import { updateItemAction } from "@/app/admin/actions/items";

// Exactly the fields `adminItemEditSchema` declares. make/model/serialNumber
// are NOT editable here (or on the item detail card) — an item's identity is
// set at creation or by CSV import only.
type ItemValues = {
  id: string;
  homeUnit: string | null;
  deviceUIC: string | null;
  deviceCategory: string | null;
  deviceName: string | null;
  currentUserEmail: string | null;
  currentPosition: string | null;
  notes: string | null;
};

const fields = [
  ["deviceName", "Device Name", true],
  ["homeUnit", "Home unit", false],
  ["deviceUIC", "Unit (UIC)", false],
  // Category groups the fleet in analytics and filters the items table. Free
  // text so a new class of device needs no migration; the datalist below just
  // nudges toward existing spellings.
  ["deviceCategory", "Category", false],
  ["currentUserEmail", "Current user email", false],
  ["currentPosition", "Current position", false],
] as const;

export function EditItemForm({ item, categories = [] }: { item: ItemValues; categories?: string[] }) {
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
              // NOT type="email", deliberately. The CSV importer copies
              // `assignedUser` into currentUserEmail verbatim with no email
              // validation (import.ts), so plenty of live rows hold a name like
              // "SGT Smith". type="email" makes the browser refuse to submit a
              // non-blank invalid value, which would block saving Device Name,
              // UIC, Category or Notes on exactly the badly-imported rows this
              // page exists to clean up. The server schema is `clearable` and
              // does not validate an address either — the client must not be
              // stricter than the thing that stores it. inputMode still gets
              // the right keyboard on a phone.
              inputMode={name === "currentUserEmail" ? "email" : undefined}
              placeholder={name === "currentUserEmail" ? "e.g. jane.doe@unit.mil" : undefined}
              required={req}
              defaultValue={item[name] ?? ""}
              list={name === "deviceCategory" ? "device-category-options" : undefined}
            />
          </div>
        ))}
        {/* Suggestions only — the field stays free text, so a new category can
            be typed without anyone editing code. */}
        <datalist id="device-category-options">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
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
        <Link href="/items" className="btn btn-ghost">Back to items</Link>
      </div>
    </form>
  );
}
