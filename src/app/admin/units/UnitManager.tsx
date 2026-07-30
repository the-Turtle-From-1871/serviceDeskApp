"use client";
import { useActionState, useState } from "react";
import {
  createUnitAction,
  renameUnitAction,
  deleteUnitAction,
  bulkLearnUnitsAction,
} from "@/app/admin/actions/units";
import type { UnitRow } from "@/modules/items/units.service";

type CreateState = { ok: true } | { error: string } | undefined;
type RenameState = { ok: true; itemsUpdated: number } | { error: string } | undefined;
type DeleteState = { ok: true } | { error: string } | undefined;
type BulkState = { ok: true; created: number; updated: number } | { error: string } | undefined;

// lastImportLabel/lastImportStale are computed server-side in page.tsx (see
// the comment there for why) — this component only decides how to render
// them, not whether the timestamp is stale.
function LastImportNotice({
  lastImportLabel,
  lastImportStale,
}: {
  lastImportLabel: string | null;
  lastImportStale: boolean;
}) {
  if (!lastImportLabel) {
    return <p className="alert-warning">No import has run yet.</p>;
  }

  if (!lastImportStale) {
    return <p className="subtle">Fleet last imported {lastImportLabel}.</p>;
  }

  return (
    <p className="alert-warning">
      Fleet last imported {lastImportLabel}. The scheduled import may not be running.
    </p>
  );
}

function UnassignedHomeUnits({
  unassigned,
}: {
  // { items, total }: items is the capped sample listUnassignedHomeUnits
  // actually fetched; total is the real count sharing that query's `where`.
  // Rendering items.length as the heading count understates the problem
  // once the fleet has more unresolved devices than the cap — see
  // listUnassignedHomeUnits in units.service.ts.
  unassigned: { items: { id: string; deviceName: string }[]; total: number };
}) {
  const { items, total } = unassigned;
  if (total === 0) return null;

  return (
    <details className="card stack-sm">
      <summary className="btn btn-secondary">
        Devices with no home unit ({total})
      </summary>
      <p className="subtle">
        These devices have no home unit. Teaching the matching abbreviation above resolves a
        device the <strong>next time</strong>{" "}
        it is included in an import — these devices already
        exist, so they match by serial, and that next import re-derives their home unit from the
        (now-known) abbreviation in their device name. A device that has dropped out of the
        export entirely is never matched, so it is never backfilled this way; set it directly on
        the item&apos;s edit page instead.
      </p>
      {total > items.length && <p className="subtle">Showing the first {items.length}.</p>}
      <ul className="stack-sm">
        {items.map((item) => (
          <li key={item.id}>{item.deviceName}</li>
        ))}
      </ul>
    </details>
  );
}

// One row editable at a time — mirrors ContactBookSection's inline-edit pattern.
function RenameUnitForm({ unit, onDone }: { unit: UnitRow; onDone: () => void }) {
  const [state, action, pending] = useActionState<RenameState, FormData>(renameUnitAction, undefined);
  const ok = state !== undefined && "ok" in state && state.ok;

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="id" value={unit.id} />
      <label className="stack" style={{ gap: 4 }}>
        <span className="label" id={`rename-${unit.id}-label`}>Full name</span>
        <input
          className="input"
          name="fullName"
          defaultValue={unit.fullName}
          required
          disabled={ok}
          aria-labelledby={`rename-${unit.id}-label`}
        />
      </label>
      {/* Advisory, not a hard confirm dialog: the count is already on the row,
          so showing it before submit costs nothing and warns before a rename
          rewrites every item that carries the old spelling. */}
      {unit.itemCount > 0 && !ok && (
        <p className="subtle">
          Renaming this unit will also update {unit.itemCount} item
          {unit.itemCount === 1 ? "" : "s"} currently assigned to it.
        </p>
      )}
      <div className="row" style={{ gap: 8 }}>
        {!ok && (
          <>
            <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
              {pending ? "Renaming…" : "Rename"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
              Cancel
            </button>
          </>
        )}
        {ok && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>
            Close
          </button>
        )}
      </div>
      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}
      {ok && (
        // itemsUpdated only counts rows that genuinely changed — 0 is a
        // truthful outcome (e.g. every item already used this spelling),
        // never presented as a failure.
        <p className="alert-success">
          Renamed. {state.itemsUpdated} item{state.itemsUpdated === 1 ? "" : "s"} updated.
        </p>
      )}
    </form>
  );
}

export function UnitManager({
  units,
  unassigned,
  lastImportLabel,
  lastImportStale,
}: {
  units: UnitRow[];
  unassigned: { items: { id: string; deviceName: string }[]; total: number };
  lastImportLabel: string | null;
  lastImportStale: boolean;
}) {
  const [addState, addAction, adding] = useActionState<CreateState, FormData>(
    createUnitAction,
    undefined,
  );
  const [bulkState, bulkAction, bulkPending] = useActionState<BulkState, FormData>(
    bulkLearnUnitsAction,
    undefined,
  );
  // deleteUnitAction takes a single FormData argument (unlike the other three
  // actions), so it is wrapped to match useActionState's (state, payload)
  // signature — the wrapper just forwards to the real action and its real
  // return value, it does not change behavior.
  const [removeState, removeAction, removing] = useActionState<DeleteState, FormData>(
    (_prev, formData) => deleteUnitAction(formData),
    undefined,
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="stack">
      <LastImportNotice lastImportLabel={lastImportLabel} lastImportStale={lastImportStale} />
      <UnassignedHomeUnits unassigned={unassigned} />

      <section className="card stack-sm">
        <h2>Add a unit</h2>
        <p className="subtle">
          The abbreviation is what the importer matches device names against; the full name is
          what shows up as an item&apos;s home unit.
        </p>
        <form action={addAction} className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="stack" style={{ gap: 4, flex: "1 1 160px" }}>
            <span className="label" id="new-unit-abbrev-label">Abbreviation</span>
            <input
              className="input"
              name="abbreviation"
              required
              maxLength={20}
              placeholder="e.g. WABC01"
              aria-labelledby="new-unit-abbrev-label"
            />
          </label>
          <label className="stack" style={{ gap: 4, flex: "2 1 220px" }}>
            <span className="label" id="new-unit-name-label">Unit name</span>
            <input
              className="input"
              name="fullName"
              required
              placeholder="e.g. HHC 1-8"
              aria-labelledby="new-unit-name-label"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding}>
            {adding ? "Adding…" : "Add unit"}
          </button>
        </form>
        {addState && "error" in addState && addState.error && (
          <p role="alert" className="alert-error">{addState.error}</p>
        )}
        {addState && "ok" in addState && addState.ok && (
          <p className="alert-success">Unit added.</p>
        )}
      </section>

      <section className="card stack-sm">
        <h2>Bulk paste</h2>
        <p className="subtle">
          One unit per line, as <strong>ABBREVIATION,Unit name</strong>. An abbreviation that
          already exists is re-taught with the new name.
        </p>
        <form action={bulkAction} className="stack-sm">
          <label className="stack" style={{ gap: 4 }}>
            <span className="label" id="bulk-units-label">Units</span>
            <textarea
              className="textarea"
              name="block"
              rows={6}
              placeholder={"WABC01,HHC 1-8"}
              required
              aria-labelledby="bulk-units-label"
            />
          </label>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={bulkPending}>
              {bulkPending ? "Adding…" : "Add units"}
            </button>
          </div>
        </form>
        {bulkState && "error" in bulkState && bulkState.error && (
          <p role="alert" className="alert-error">{bulkState.error}</p>
        )}
        {bulkState && "ok" in bulkState && bulkState.ok && (
          // created/updated are real counts from learnUnits, not estimates —
          // report them separately rather than collapsing to one number.
          <p className="alert-success">
            {bulkState.created} added, {bulkState.updated} updated.
          </p>
        )}
      </section>

      <section className="card stack-sm">
        <h2>Units ({units.length})</h2>
        {removeState && "error" in removeState && removeState.error && (
          <p role="alert" className="alert-error">{removeState.error}</p>
        )}
        {removeState && "ok" in removeState && removeState.ok && (
          <p className="alert-success">Unit removed.</p>
        )}

        {units.length === 0 ? (
          <p className="subtle">No units yet. Add one above.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Abbreviation</th>
                  <th>Full name</th>
                  <th>Items</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) =>
                  editingId === u.id ? (
                    <tr key={u.id}>
                      <td colSpan={4} data-label="">
                        <RenameUnitForm unit={u} onDone={() => setEditingId(null)} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={u.id}>
                      <td className="mono" data-label="Abbreviation">{u.abbreviation}</td>
                      <td data-label="Full name">{u.fullName}</td>
                      <td data-label="Items" className="tabular-nums">{u.itemCount}</td>
                      <td data-label="">
                        <div className="actions actions--end">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setEditingId(u.id)}
                          >
                            Rename
                          </button>
                          <form action={removeAction}>
                            <input type="hidden" name="id" value={u.id} />
                            {/* A unit in use is not removable: deleting it would
                                leave those devices holding a home-unit value that
                                matches no vocabulary row. The button is disabled
                                AND the server refuses — the disabled state is a
                                hint, the server check is the rule. */}
                            <button
                              type="submit"
                              className="btn btn-danger btn-sm"
                              disabled={removing || u.itemCount > 0}
                              title={
                                u.itemCount > 0
                                  ? `Still the home unit of ${u.itemCount} item${u.itemCount === 1 ? "" : "s"} — reassign them first.`
                                  : undefined
                              }
                            >
                              Remove
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
