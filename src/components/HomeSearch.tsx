"use client";
import { useEffect, useRef, useState } from "react";
import { liveSearchAction, type ItemResult, type ReceiptHit } from "@/app/actions/search";

export function HomeSearch() {
  const [mode, setMode] = useState<"serial" | "receipt">("serial");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ItemResult[]>([]);
  const [receipts, setReceipts] = useState<ReceiptHit[]>([]);
  // The query the currently-held results correspond to. Used so "No matches"
  // only shows once the *current* query has resolved (avoids a debounce flash).
  const [resolvedQuery, setResolvedQuery] = useState("");
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) return; // blank query: nothing to fetch; render hides stale results via hasQuery
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      try {
        const res = await liveSearchAction(mode, q);
        if (id !== reqId.current) return; // ignore out-of-order responses
        setItems(res.items ?? []);
        setReceipts(res.receipts ?? []);
        setResolvedQuery(q);
      } catch {
        if (id === reqId.current) { setItems([]); setReceipts([]); setResolvedQuery(q); }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [mode, query]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  // Only render "No matches" once the current query has actually resolved, so it
  // doesn't flash (or get announced) during the debounce before results land.
  const settled = resolvedQuery === trimmed;
  const noMatches = hasQuery && settled && (mode === "serial" ? items.length === 0 : receipts.length === 0);

  return (
    <div className="stack">
      <div className="row">
        <select className="select" aria-label="Search by" value={mode} onChange={(e) => setMode(e.target.value === "receipt" ? "receipt" : "serial")}>
          <option value="serial">Serial number</option>
          <option value="receipt">Hand receipt number</option>
        </select>
        <input className="input" aria-label="Search" placeholder="Start typing…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {/* Type-ahead has no submit, so announce result changes to assistive tech. */}
      <div aria-live="polite" role="status">
        {noMatches && <p className="subtle">No matches.</p>}

        {hasQuery && mode === "serial" && items.length > 0 && (
          <ul className="stack-sm">
            {items.map((r) => (
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

        {hasQuery && mode === "receipt" && receipts.length > 0 && (
          <ul className="stack-sm">
            {receipts.map((r) => (
              <li key={r.receiptNumber} className="card row">
                <div>
                  <div><strong>{r.receiptNumber}</strong></div>
                  <div className="subtle">{r.itemSummary}</div>
                </div>
                <span className="spacer" />
                <a className="btn btn-secondary btn-sm" href={`/receipts/${r.receiptNumber}`}>View receipt</a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
