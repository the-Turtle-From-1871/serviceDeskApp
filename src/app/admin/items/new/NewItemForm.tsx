"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";
import { SuggestCombobox } from "@/components/SuggestCombobox";
import type { ItemFieldSuggestions } from "@/modules/items/items.service";

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["deviceName", "Device Name", true],
  ["homeUnit", "Home unit", false],
  ["deviceUIC", "Unit (UIC)", false],
  ["deviceCategory", "Category", false],
] as const;

export function NewItemForm({
  serialNumber = "",
  cameFromSearch = false,
  returnUic = "",
  categories = [],
  units = [],
  suggestions,
}: {
  serialNumber?: string;
  cameFromSearch?: boolean;
  returnUic?: string;
  categories?: string[];
  units?: string[];
  suggestions: ItemFieldSuggestions;
}) {
  const [state, action, pending] = useActionState(createItemAction, undefined);

  // Which vocabulary feeds which field. Category and Home unit come from the
  // MANAGED lists (/admin/categories, /admin/units) rather than from observed
  // item values — sourcing them from DISTINCT Item would resurrect names an
  // admin deliberately deleted and make the picker disagree with the screens
  // that curate them. Make/model/UIC have no managed list, so their vocabulary
  // is what the fleet already holds.
  const optionsFor: Record<string, string[] | undefined> = {
    make: suggestions.make,
    model: suggestions.model,
    deviceUIC: suggestions.deviceUIC,
    homeUnit: units,
    deviceCategory: categories,
  };

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
            {optionsFor[name] ? (
              <SuggestCombobox
                id={name}
                name={name}
                options={optionsFor[name]!}
                required={req}
                defaultValue={name === "deviceUIC" ? returnUic : ""}
              />
            ) : (
              <input
                id={name}
                className="input"
                name={name}
                required={req}
                defaultValue={name === "serialNumber" ? serialNumber : undefined}
              />
            )}
          </div>
        ))}
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
