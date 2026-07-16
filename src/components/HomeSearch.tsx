"use client";
import { useEffect, useRef, useState } from "react";
import { liveSearchAction, type LiveSearchResult } from "@/app/actions/search";

export function HomeSearch() {
  const [mode, setMode] = useState<"serial" | "receipt">("serial");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<LiveSearchResult>({});
  // The (mode, query) the held result corresponds to. Keying on BOTH means a
  // mode switch invalidates `settled` until the new search resolves, so
  // "No matches" never flashes for a mode/query that hasn't been fetched yet.
  const [resolvedKey, setResolvedKey] = useState("");
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) return; // blank query: nothing to fetch; render hides stale results via hasQuery
    const id = ++reqId.current;
    const key = `${mode}\n${q}`;
    const timer = setTimeout(async () => {
      try {
        const res = await liveSearchAction(mode, q);
        if (id !== reqId.current) return; // ignore out-of-order responses
        setResult(res);
        setResolvedKey(key);
      } catch {
        if (id === reqId.current) { setResult({}); setResolvedKey(key); }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [mode, query]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const items = result.items ?? [];
  const receipts = result.receipts ?? [];
  // Only render "No matches" once the current (mode, query) has resolved, so it
  // doesn't flash (or get announced) during the debounce or right after a mode switch.
  const settled = resolvedKey === `${mode}\n${trimmed}`;
  const noMatches = hasQuery && settled && (mode === "serial" ? items.length === 0 : receipts.length === 0);

  return (
    <div className="stack">
      <div className="row search-row">
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
