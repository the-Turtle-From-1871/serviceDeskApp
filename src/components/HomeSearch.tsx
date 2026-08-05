"use client";
import { useEffect, useRef, useState } from "react";
import { liveSearchAction, type LiveSearchResult } from "@/app/actions/search";
import { Progress } from "@/components/ui/progress";

export function HomeSearch() {
  const [mode, setMode] = useState<"serial" | "receipt">("serial");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<LiveSearchResult>({});
  // The (mode, query) the held result corresponds to. Keying on BOTH means a
  // mode switch invalidates `settled` until the new search resolves, so
  // "No matches" never flashes for a mode/query that hasn't been fetched yet.
  const [resolvedKey, setResolvedKey] = useState("");
  // Distinguishes "the search could not run" from "the search ran and found
  // nothing" — see the catch below.
  const [failed, setFailed] = useState(false);
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
        setFailed(false);
      } catch {
        // A failure is NOT an empty result. The anonymous 100/min proxy bucket
        // is shared by everyone behind one egress IP, so a throttled search
        // used to land here and render "No matches." — telling a logged-out
        // soldier their serial number does not exist, which is a confident
        // wrong answer about the property book.
        if (id === reqId.current) { setResult({}); setResolvedKey(key); setFailed(true); }
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
  // Derived, not a third piece of state: "not settled" already means the held
  // result does not correspond to what is in the box, which covers BOTH halves
  // of the wait — the 250ms debounce and the round trip after it. Tracking a
  // separate `pending` flag would be a second source of truth that could
  // disagree with `settled` on the mode-switch and out-of-order-response paths
  // this component already handles.
  const pending = hasQuery && !settled;
  // The unlock cookie lasts 12 hours, so it can lapse while this page sits open
  // — the search then comes back refused rather than empty. Saying "No matches"
  // there is the same confident wrong answer about the property book that the
  // `failed` branch below exists to avoid, so it gets its own way out.
  const locked = result.locked === true;
  const noMatches =
    hasQuery &&
    settled &&
    !failed &&
    !locked &&
    (mode === "serial" ? items.length === 0 : receipts.length === 0);

  return (
    <div className="stack">
      <div className="row search-row">
        <select className="select" aria-label="Search by" value={mode} onChange={(e) => setMode(e.target.value === "receipt" ? "receipt" : "serial")}>
          <option value="serial">Serial number</option>
          <option value="receipt">Hand receipt number</option>
        </select>
        <input className="input" aria-label="Search" placeholder="Start typing…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {/* Deliberately OUTSIDE the aria-live region below: a progress bar that
          re-renders on every keystroke would spam a screen reader with
          announcements, and the results region already narrates the outcome.
          Kept mounted for the whole time there is a query — collapsing it when
          the search settles would bounce the results list by 2px on every
          keystroke. `value={0}` is the settled (empty track) state; `null` is
          Radix's indeterminate state, which is what animates. */}
      {hasQuery && (
        <Progress
          value={pending ? null : 0}
          aria-hidden={!pending}
          aria-label={pending ? "Searching" : undefined}
        />
      )}

      {/* Type-ahead has no submit, so announce result changes to assistive tech. */}
      <div aria-live="polite" role="status">
        {noMatches && <p className="subtle">No matches.</p>}
        {hasQuery && settled && locked && (
          <p role="alert" className="subtle">
            Your access has expired. <a href="/unlock?next=%2F">Enter the access PIN</a> to search
            again.
          </p>
        )}
        {hasQuery && settled && failed && (
          <p role="alert" className="subtle">
            Search is temporarily unavailable. Please try again in a moment.
          </p>
        )}

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
