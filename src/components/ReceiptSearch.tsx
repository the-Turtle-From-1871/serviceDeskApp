"use client";
import { useActionState } from "react";
import { searchReceiptsAction, type ReceiptResult } from "@/app/actions/receipts";

export function ReceiptSearch() {
  const [state, action, pending] = useActionState(searchReceiptsAction, undefined);
  const results: ReceiptResult[] | undefined = state && "results" in state ? state.results : undefined;
  return (
    <div className="stack">
      <form action={action} className="row">
        <input className="input" name="query" placeholder="Serial number or HR-XXXXXXXX" required aria-label="Search" />
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Searching…" : "Search"}</button>
      </form>
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
      {results && results.length === 0 && <p className="subtle">No receipts found.</p>}
      {results && results.length > 0 && (
        <ul className="stack-sm">
          {results.map((r) => (
            <li key={r.receiptNumber} className="card row">
              <div>
                <div><strong>{r.receiptNumber}</strong> — {r.itemSummary}</div>
                <div className="subtle">{r.fromLabel} → {r.toLabel}</div>
              </div>
              <span className="spacer" />
              <a className="btn btn-secondary btn-sm" href={`/receipts/${r.receiptNumber}/pdf`}>Download PDF</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
