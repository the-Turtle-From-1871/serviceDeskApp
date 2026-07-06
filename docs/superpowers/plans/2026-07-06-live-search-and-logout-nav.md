# Live Search + Logout/Login Nav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the home search query live as you type (both modes, click a result), send logout back to the search page, and add a "back to search" link on the login page.

**Architecture:** Replace the redirecting `searchAction` with a results-only `liveSearchAction` called imperatively from a debounced client `HomeSearch`; change the logout redirect; add a login link.

**Tech Stack:** Next.js 16.2.9 (App Router, Server Actions), Prisma 7, React 19, Vitest.

## Global Constraints

- **Next.js 16:** server actions are `"use server"`; they may be called imperatively from client components with plain serializable args (same pattern as the existing prefill lookup). Client components are `"use client"`.
- **Live search returns results, never redirects.** Both modes show a clickable list; the Search button is removed; the mode dropdown stays.
- **No schema change** — code-only deploy (no migration).
- **Commit** after each task's tests pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

---

## File Structure

**Modified**
- `src/app/actions/search.ts` — replace `searchAction` with `liveSearchAction`
- `src/app/actions/search.test.ts` — test `liveSearchAction` (no redirects)
- `src/components/HomeSearch.tsx` — debounced live type-ahead
- `src/app/actions/auth.ts` — `logoutAction` redirect `/login` → `/`
- `src/app/login/page.tsx` — add "← Back to search" link

---

## Task 1: Live search

**Files:**
- Modify: `src/app/actions/search.ts`, `src/app/actions/search.test.ts`, `src/components/HomeSearch.tsx`

**Interfaces:**
- Consumes: `searchItemsBySerial(q)` (`@/modules/items/items.service`, caps at 50); `getTransferByReceiptNumber(n)` (`@/modules/transfers/transfers.service`, returns a transfer with `item` + `itemSummary`, or null).
- Produces: `liveSearchAction(mode: string, query: string): Promise<LiveSearchResult>` where `LiveSearchResult = { items?: ItemResult[]; receipt?: ReceiptHit | null }`, `ItemResult = { id, make, model, serialNumber, status }`, `ReceiptHit = { receiptNumber, itemSummary }`.

- [ ] **Step 1: Replace the search action test**

Replace `src/app/actions/search.test.ts` entirely:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const searchItemsBySerial = vi.fn();
const getTransferByReceiptNumber = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n) }));

import { liveSearchAction } from "./search";

beforeEach(() => vi.clearAllMocks());

describe("liveSearchAction", () => {
  it("returns empty items for a blank query without hitting the services", async () => {
    expect(await liveSearchAction("serial", "  ")).toEqual({ items: [] });
    expect(searchItemsBySerial).not.toHaveBeenCalled();
    expect(getTransferByReceiptNumber).not.toHaveBeenCalled();
  });
  it("serial: maps matches to ItemResult[] (dropping extra fields)", async () => {
    searchItemsBySerial.mockResolvedValue([{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE", createdAt: new Date() }]);
    expect(await liveSearchAction("serial", "SN1")).toEqual({ items: [{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" }] });
  });
  it("receipt: returns the hit when found", async () => {
    getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000042", itemSummary: "Dell L (SN SN1)" });
    expect(await liveSearchAction("receipt", "hr-000042")).toEqual({ receipt: { receiptNumber: "HR-000042", itemSummary: "Dell L (SN SN1)" } });
  });
  it("receipt: returns null when not found", async () => {
    getTransferByReceiptNumber.mockResolvedValue(null);
    expect(await liveSearchAction("receipt", "HR-999")).toEqual({ receipt: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- actions/search`
Expected: FAIL — `liveSearchAction` not exported (old `searchAction` still there).

- [ ] **Step 3: Replace the action**

Replace `src/app/actions/search.ts` entirely:
```ts
"use server";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };
export type ReceiptHit = { receiptNumber: string; itemSummary: string };
export type LiveSearchResult = { items?: ItemResult[]; receipt?: ReceiptHit | null };

// Live type-ahead: returns results only (never redirects). Blank query → empty.
export async function liveSearchAction(mode: string, query: string): Promise<LiveSearchResult> {
  const q = query.trim();
  if (!q) return { items: [] };

  if (mode === "receipt") {
    const t = await getTransferByReceiptNumber(q);
    return { receipt: t ? { receiptNumber: t.receiptNumber, itemSummary: t.itemSummary } : null };
  }

  const items = await searchItemsBySerial(q);
  return { items: items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status })) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- actions/search`
Expected: PASS (4 cases).

- [ ] **Step 5: Rewrite HomeSearch as a debounced type-ahead**

Replace `src/components/HomeSearch.tsx` entirely:
```tsx
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
    if (!q) { setItems([]); setReceipt(undefined); return; }
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

      {mode === "serial" && items.length > 0 && (
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

      {mode === "receipt" && receipt && (
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
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` (0 errors), `npm test` (all pass), `npm run lint` (clean), `npm run build` (succeeds). Grep: `git grep -n "searchAction" -- src` → no matches (only `liveSearchAction`).

- [ ] **Step 7: Commit**

```bash
git add src/app/actions/search.ts src/app/actions/search.test.ts src/components/HomeSearch.tsx
git commit -m "feat(search): live type-ahead results (both modes, click to open)"
```

---

## Task 2: Logout redirect + login back-to-search link

**Files:**
- Modify: `src/app/actions/auth.ts`, `src/app/login/page.tsx`

- [ ] **Step 1: Send logout to the search page**

In `src/app/actions/auth.ts`, in `logoutAction`, change `signOut({ redirectTo: "/login" })` → `signOut({ redirectTo: "/" })`.

- [ ] **Step 2: Add the login "back to search" link**

In `src/app/login/page.tsx` (already imports `Link` from `next/link`), add as the first child inside the card `<div className="card stack" …>` (immediately before the `<div className="stack-sm">` brand block):
```tsx
        <Link href="/" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}>← Back to search</Link>
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (0), `npm run build` (succeeds), `npm test` (unchanged-green).

- [ ] **Step 4: Commit**

```bash
git add src/app/actions/auth.ts src/app/login/page.tsx
git commit -m "feat(nav): logout returns to search; login page 'back to search' link"
```

---

## Task 3: Final verification & smoke checklist

- [ ] **Step 1: Full gates** — `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.
- [ ] **Step 2: Document the manual smoke checklist** (run after deploy):
  1. Home: type a partial serial → item results appear live (no button press); click → `/i/[id]`.
  2. Switch mode to "Hand receipt number", type a number → the receipt row appears live; click → `/receipts/[n]`. A wrong number shows "No matches."
  3. Sign out → lands on `/` (the search page), not `/login`.
  4. On `/login`, "← Back to search" returns to `/`.
- [ ] **Step 3: Commit** any doc change (skip if none).

---

## Self-Review (coverage map)

- **Search-as-you-type, both modes, click a result, no Search button** → Task 1 (`liveSearchAction` + debounced `HomeSearch`).
- **Logout → search page** → Task 2 Step 1.
- **Login "back to search"** → Task 2 Step 2.
