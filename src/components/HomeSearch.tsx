"use client";
import { useEffect, useRef, useState } from "react";
import { liveSearchAction, type ItemResult, type ReceiptHit } from "@/app/actions/search";

export function HomeSearch() {
  const [mode, setMode] = useState<"serial" | "receipt">("serial");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ItemResult[]>([]);
  const [receipt, setReceipt] = useState<ReceiptHit | null | undefined>(undefined);
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
        setReceipt(res.receipt);
      } catch {
        if (id === reqId.current) { setItems([]); setReceipt(undefined); }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [mode, query]);

  const hasQuery = query.trim().length > 0;
  const noMatches = hasQuery && (mode === "serial" ? items.length === 0 : receipt === null);

  return (
    <div className="stack">
      <div className="row">
        <select className="select" aria-label="Search by" value={mode} onChange={(e) => setMode(e.target.value === "receipt" ? "receipt" : "serial")}>
          <option value="serial">Serial number</option>
          <option value="receipt">Hand receipt number</option>
        </select>
        <input className="input" aria-label="Search" placeholder="Start typing…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

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

      {hasQuery && mode === "receipt" && receipt && (
        <ul className="stack-sm">
          <li className="card row">
            <div>
              <div><strong>{receipt.receiptNumber}</strong></div>
              <div className="subtle">{receipt.itemSummary}</div>
            </div>
            <span className="spacer" />
            <a className="btn btn-secondary btn-sm" href={`/receipts/${receipt.receiptNumber}`}>View receipt</a>
          </li>
        </ul>
      )}
    </div>
  );
}
