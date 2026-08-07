"use client";
import { useActionState, useState } from "react";
import { updateItemDetailsAction } from "@/app/actions/items";
import { SuggestCombobox } from "@/components/SuggestCombobox";
import type { ItemFieldSuggestions } from "@/modules/items/items.service";

export type ItemDetailsValues = {
  id: string;
  deviceName: string | null;
  homeUnit: string | null;
  deviceUIC: string | null;
  deviceCategory: string | null;
  storageLocation: string | null;
  currentUserEmail: string | null;
  currentPosition: string | null;
  notes: string | null;
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  enrollmentDate: string | null;
  compliance: string | null;
};

type Props = {
  item: ItemDetailsValues;
  isAdmin: boolean;
  units: { abbreviation: string; fullName: string }[];
  // The MANAGED device-category vocabulary, for the picker below. Suggestions
  // only — Item.deviceCategory stays free text on purpose.
  categories: string[];
  // The free-text catalogue vocabularies (make/model/UIC), for the same
  // suggestion mechanism. Admin-only, like `units` and `categories` above.
  suggestions: ItemFieldSuggestions;
  // Pre-formatted on the server so this component stays free of date/party logic.
  dateLogged: string;
  loggedBy: string;
  handReceiptHolder: string;
  lastEdited: string | null;
};

const dash = <span className="subtle">—</span>;

export function ItemDetailsCard({ item, isAdmin, units, categories, suggestions, dateLogged, loggedBy, handReceiptHolder, lastEdited }: Props) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateItemDetailsAction, undefined);

  // Leave edit mode once a save succeeds; the server re-renders with new values.
  // "Storing information from previous renders" pattern (see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // compared on `state` IDENTITY, not a derived boolean, and only written when it
  // changes from the previous render — never unconditionally — so this is a
  // guarded render-time write, not the unconditional kind react-hooks/set-state-in-render
  // flags. useActionState returns the SAME object across re-renders until a new
  // submit resolves, so every successful submit yields a fresh object (closing the
  // editor, even on a second save), while merely re-opening the editor via the
  // Edit button leaves `state` unchanged (so it stays open). A boolean dep, or an
  // unconditional write, would leave `ok` true forever and slam the form shut every
  // time Edit was clicked again — do not "simplify" this into either.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state && "ok" in state && state.ok) setEditing(false);
  }

  return (
    <div className="card">
      <div className="row">
        <div className="card__title">Item details</div>
        <span className="spacer" />
        {!editing && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <form action={action} className="stack-sm">
          <input type="hidden" name="id" value={item.id} />
          <div className="form-grid">
            {/* deviceName, homeUnit, deviceUIC, deviceCategory and notes are
                ADMIN-only. A standard USER edits only the current holder email
                and position, so these inputs are not rendered for them — and
                updateItemDetailsAction re-enforces this server-side by picking
                userItemDetailsSchema, which strips them. */}
            {isAdmin && (
              <>
                <div className="field">
                  <label className="label" htmlFor="ed-deviceName">Device Name<span className="req"> *</span></label>
                  <input id="ed-deviceName" className="input" name="deviceName" defaultValue={item.deviceName ?? ""} required />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-homeUnit">Home unit</label>
                  <SuggestCombobox
                    id="ed-homeUnit"
                    name="homeUnit"
                    options={units.map((u) => u.fullName)}
                    placeholder="Search units…"
                    defaultValue={item.homeUnit ?? ""}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-deviceUIC">Unit (UIC)</label>
                  <SuggestCombobox
                    id="ed-deviceUIC"
                    name="deviceUIC"
                    options={suggestions.deviceUIC}
                    defaultValue={item.deviceUIC ?? ""}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-deviceCategory">Category</label>
                  {/* Free text with the managed vocabulary as SUGGESTIONS, never
                      a locked <select> — an unregistered category must stay
                      typeable (it is learned into the list on save). */}
                  <SuggestCombobox
                    id="ed-deviceCategory"
                    name="deviceCategory"
                    options={categories}
                    placeholder="e.g. Laptop"
                    defaultValue={item.deviceCategory ?? ""}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-storageLocation">Storage location (SLoc)</label>
                  <SuggestCombobox
                    id="ed-storageLocation"
                    name="storageLocation"
                    options={suggestions.storageLocation}
                    placeholder="e.g. Bldg 400 Cage 3"
                    defaultValue={item.storageLocation ?? ""}
                  />
                </div>
              </>
            )}
            <div className="field">
              <label className="label" htmlFor="ed-currentUserEmail">Current user email</label>
              {/* inputMode, NOT type="email" — CSV-imported rows hold names like
                  "SGT Smith" in this column (import.ts copies `assignedUser`
                  verbatim), and a browser-side email constraint would block
                  saving the OTHER fields on this form. The server schema does
                  not validate an address either. */}
              <input id="ed-currentUserEmail" className="input" inputMode="email" name="currentUserEmail" defaultValue={item.currentUserEmail ?? ""} placeholder="e.g. jane.doe@unit.mil" />
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-currentPosition">Current position</label>
              <input id="ed-currentPosition" className="input" name="currentPosition" defaultValue={item.currentPosition ?? ""} placeholder="e.g. Supply Sergeant" />
            </div>
            {isAdmin && (
              <div className="field col-span-2">
                <label className="label" htmlFor="ed-notes">Notes</label>
                <textarea id="ed-notes" className="textarea" name="notes" defaultValue={item.notes ?? ""} />
              </div>
            )}
          </div>
          {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="dl">
          <dt>Device Name</dt>
          <dd>{item.deviceName || dash}</dd>
          <dt>Home unit</dt>
          <dd>{item.homeUnit || dash}</dd>
          <dt>Device UIC</dt>
          <dd>{item.deviceUIC || dash}</dd>
          <dt>Category</dt>
          <dd>{item.deviceCategory || dash}</dd>
          <dt>Storage location</dt>
          <dd>{item.storageLocation || dash}</dd>
          <dt>Current user email</dt>
          <dd>{item.currentUserEmail || dash}</dd>
          <dt>Current position</dt>
          <dd>{item.currentPosition || dash}</dd>
          <dt>Last logon user</dt>
          <dd>{item.lastLogonUserPrincipalName || dash}</dd>
          <dt>Last logon date</dt>
          <dd>{item.lastLogonDate || dash}</dd>
          <dt>Enrollment date</dt>
          <dd>{item.enrollmentDate || dash}</dd>
          <dt>Compliance</dt>
          <dd>{item.compliance || dash}</dd>
          {isAdmin && (
            <>
              <dt>Notes</dt>
              <dd>{item.notes || dash}</dd>
            </>
          )}
          <dt>Date logged</dt>
          <dd>{dateLogged}</dd>
          <dt>Logged by</dt>
          <dd>{loggedBy}</dd>
          <dt>Hand-receipt holder</dt>
          <dd>{handReceiptHolder}</dd>
          {lastEdited && (
            <>
              <dt>Last edited</dt>
              <dd className="subtle">{lastEdited}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
