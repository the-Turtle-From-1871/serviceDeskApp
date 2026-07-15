"use client";
import { useActionState, useEffect, useState } from "react";
import { updateItemDetailsAction } from "@/app/actions/items";

export type ItemDetailsValues = {
  id: string;
  deviceName: string | null;
  homeUnit: string | null;
  currentUser: string | null;
  currentPosition: string | null;
  notes: string | null;
};

type Props = {
  item: ItemDetailsValues;
  isAdmin: boolean;
  units: { abbreviation: string; fullName: string }[];
  // Pre-formatted on the server so this component stays free of date/party logic.
  dateLogged: string;
  loggedBy: string;
  handReceiptHolder: string;
  lastEdited: string | null;
};

const dash = <span className="subtle">—</span>;

export function ItemDetailsCard({ item, isAdmin, units, dateLogged, loggedBy, handReceiptHolder, lastEdited }: Props) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateItemDetailsAction, undefined);

  // Leave edit mode once a save succeeds; the server re-renders with new values.
  // Keyed on `state` IDENTITY, not on a derived boolean: every successful submit
  // returns a fresh object, so a second save also closes the editor — while
  // merely re-opening the editor does not change `state`, so it stays open.
  // (A boolean dep, or setting state during render, would leave `ok` true
  // forever and slam the form shut every time Edit was clicked again.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: see note above.
    if (state && "ok" in state && state.ok) setEditing(false);
  }, [state]);

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
            <div className="field">
              <label className="label" htmlFor="ed-deviceName">Device Name<span className="req"> *</span></label>
              <input id="ed-deviceName" className="input" name="deviceName" defaultValue={item.deviceName ?? ""} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-homeUnit">Home unit</label>
              <input
                id="ed-homeUnit"
                className="input"
                name="homeUnit"
                list="ed-units"
                autoComplete="off"
                placeholder="Search units…"
                defaultValue={item.homeUnit ?? ""}
              />
              <datalist id="ed-units">
                {units.map((u) => <option key={u.abbreviation} value={u.fullName}>{u.abbreviation}</option>)}
              </datalist>
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-currentUser">Current user</label>
              <input id="ed-currentUser" className="input" name="currentUser" defaultValue={item.currentUser ?? ""} placeholder="e.g. SGT Smith" />
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-currentPosition">Current position</label>
              <input id="ed-currentPosition" className="input" name="currentPosition" defaultValue={item.currentPosition ?? ""} placeholder="e.g. Supply Sergeant" />
            </div>
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
          <dt>Current user</dt>
          <dd>{item.currentUser || dash}</dd>
          <dt>Current position</dt>
          <dd>{item.currentPosition || dash}</dd>
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
