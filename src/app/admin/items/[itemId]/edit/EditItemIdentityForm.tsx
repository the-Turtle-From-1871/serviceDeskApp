"use client";
import { useActionState } from "react";
import { updateItemIdentityAction } from "@/app/admin/actions/items";
import { SuggestCombobox } from "@/components/SuggestCombobox";
import type { ItemFieldSuggestions } from "@/modules/items/items.service";

// The identity-correction form: make / model / serialNumber, exactly the fields
// `itemIdentitySchema` declares.
//
// A SEPARATE card and a SEPARATE submit from the main eight-field form on
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

export function EditItemIdentityForm({ item, suggestions }: { item: IdentityValues; suggestions: ItemFieldSuggestions }) {
  const [state, action, pending] = useActionState(updateItemIdentityAction, undefined);
  const saved = !!(state && "ok" in state && state.ok);

  const optionsFor: Record<string, string[] | undefined> = {
    make: suggestions.make,
    model: suggestions.model,
    // serialNumber is deliberately absent: it is an identity, not a vocabulary,
    // and suggesting one would be actively wrong.
  };

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
            {optionsFor[name] ? (
              <SuggestCombobox
                id={`identity-${name}`}
                name={name}
                options={optionsFor[name]!}
                required
                defaultValue={item[name]}
              />
            ) : (
              <input
                id={`identity-${name}`}
                className="input"
                name={name}
                required
                defaultValue={item[name]}
              />
            )}
          </div>
        ))}
      </div>
      {/* Says what actually happens. An earlier version claimed correcting a
          serial "changes what existing receipts appear to describe" — the
          opposite of the truth: TransferItem.serialNumber is a SNAPSHOT taken
          when the receipt was created (transfers.service.ts) and the receipt
          page renders that snapshot, never joining back to Item. Past receipts
          are therefore frozen, which is right for a signed document, but the
          admin needs to know they will NOT self-heal. */}
      <p className="alert-warning">
        Hand receipts already signed keep the serial they were issued with — correcting
        it here will not update them, so past receipts will go on showing a serial that
        no longer matches this item. They still link to the item itself.
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
