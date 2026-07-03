"use client";
import { useActionState } from "react";
import { searchAction, type ItemResult } from "@/app/actions/search";

export function HomeSearch() {
  const [state, action, pending] = useActionState(searchAction, undefined);
  const results: ItemResult[] | undefined = state && "results" in state ? state.results : undefined;
  return (
    <div className="stack">
      <form action={action} className="row">
        <select className="select" name="mode" defaultValue="serial" aria-label="Search by">
          <option value="serial">Serial number</option>
          <option value="receipt">Hand receipt number</option>
        </select>
        <input className="input" name="query" placeholder="Search…" required aria-label="Search" />
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Searching…" : "Search"}</button>
      </form>
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
      {results && results.length > 0 && (
        <ul className="stack-sm">
          {results.map((r) => (
            <li key={r.id} className="card row">
              <div>
                <div><strong>{r.make} {r.model}</strong></div>
                <div className="subtle">SN {r.serialNumber} · {r.status}</div>
              </div>
              <span className="spacer" />
              <a className="btn btn-secondary btn-sm" href={`/i/${r.id}`}>View item</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
