"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["deviceName", "Device Name", true],
  ["homeUnit", "Home unit", false],
  ["deviceUIC", "UIC", false],
  ["deviceCategory", "Category", false],
] as const;

export function NewItemForm({
  serialNumber = "",
  cameFromSearch = false,
  returnUic = "",
  categories = [],
  units = [],
}: {
  serialNumber?: string;
  cameFromSearch?: boolean;
  returnUic?: string;
  categories?: string[];
  units?: string[];
}) {
  const [state, action, pending] = useActionState(createItemAction, undefined);

  // Only reachable when the form was NOT opened from a search — that path
  // redirects to /items instead of returning, so it never renders this.
  if (state && "itemId" in state && state.itemId) {
    return (
      <div className="card stack">
        <p className="alert-success">Item created successfully.</p>
        <div className="row">
          <Link href="/admin/items/new" className="btn btn-secondary">Add another</Link>
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="card stack">
      {cameFromSearch && (
        <>
          {/* Read directly off formData in the action — newItemSchema is a
              z.object() and would strip them from the parsed result. */}
          <input type="hidden" name="fromSearch" value="1" />
          <input type="hidden" name="returnUic" value={returnUic} />
        </>
      )}
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
              defaultValue={name === "serialNumber" ? serialNumber : undefined}
              list={
                name === "deviceCategory" ? "device-category-options"
                : name === "homeUnit" ? "home-unit-options"
                : undefined
              }
            />
          </div>
        ))}
        {/* Suggestions only — both fields stay free text. An unknown category is
            registered on save (the CSV import can introduce one, so the form
            must not be stricter); an unknown unit is not, because a Unit is
            keyed on an abbreviation a typed full name does not carry. */}
        <datalist id="device-category-options">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <datalist id="home-unit-options">
          {units.map((u) => <option key={u} value={u} />)}
        </datalist>
        <div className="field col-span-2">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea id="notes" className="textarea" name="notes" placeholder="Optional details about this item" />
        </div>
      </div>
      {state?.error && (
        <p role="alert" className="alert-error">
          {state.error}
          {"existingItemId" in state && state.existingItemId && (
            <> <Link href={`/i/${state.existingItemId}`}>Open that item</Link></>
          )}
        </p>
      )}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Create item"}
        </button>
        <Link href="/items" className="btn btn-ghost">Cancel</Link>
      </div>
    </form>
  );
}
