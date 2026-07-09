"use client";
import { useActionState } from "react";
import Link from "next/link";
import { importItemsAction } from "@/app/admin/actions/items";

const TEMPLATE = "make,model,serialNumber,homeUnit,notes\n";

function groupSkipped(skipped: { row: number; serialNumber: string; reason: string }[]) {
  const by = new Map<string, string[]>();
  for (const s of skipped) {
    const label = s.serialNumber ? s.serialNumber : `row ${s.row}`;
    by.set(s.reason, [...(by.get(s.reason) ?? []), label]);
  }
  return [...by.entries()];
}

export function ImportItemsForm() {
  const [state, action, pending] = useActionState(importItemsAction, undefined);
  const done = state && "added" in state;

  return (
    <div className="stack">
      <form action={action} className="card stack">
        <div className="field">
          <label className="label" htmlFor="file">CSV file</label>
          <input id="file" className="input" type="file" name="file" accept=".csv" required />
          <p className="subtle">Columns: make, model, serialNumber, homeUnit, notes. First row must be the header.</p>
        </div>
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        <div className="row">
          <button disabled={pending} type="submit" className="btn btn-primary">{pending ? "Importing…" : "Import CSV"}</button>
          <a className="btn btn-ghost" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="item-import-template.csv">Download template</a>
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </form>

      {done && (
        <div className="card stack-sm">
          <p className="alert-success">{state.added} item{state.added === 1 ? "" : "s"} added.</p>
          {state.skipped.length > 0 ? (
            <div className="stack-sm">
              <p><strong>{state.skipped.length} skipped:</strong></p>
              <ul>
                {groupSkipped(state.skipped).map(([reason, labels]) => (
                  <li key={reason}>{reason}: {labels.join(", ")}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="subtle">No rows were skipped.</p>
          )}
        </div>
      )}
    </div>
  );
}
