# Live Search + Logout/Login Nav — Design

**Date:** 2026-07-06
**Status:** Approved (pending spec review)
**Builds on:** the shipped public item page + search-dropdown work.

## Summary

Three small UI changes:

1. **Search-as-you-type** on the public home page — results appear live as the
   user types (debounced), for both modes; you click a result to open it. This
   replaces the current "press Search → auto-redirect to the single match" model.
2. **Logout returns to the search page** (`/`), not the login page.
3. **Login page gets a "← Back to search" link** back to `/`.

No schema change — code-only deploy (no migration).

## Decisions (from brainstorming)

- Live search covers **both modes** (Serial → items, Hand receipt number → the
  matching receipt); results are a **clickable list**, no auto-redirect; the
  **Search button is removed**; the mode dropdown stays.

## Architecture

### A. Live search — `/`

- **New server action** `liveSearchAction(mode, query)` in `src/app/actions/search.ts`
  (replaces the redirecting `searchAction`). It **returns results, never
  redirects**:
  - `query` blank/whitespace → `{ items: [] }` (empty).
  - `mode === "receipt"` → `getTransferByReceiptNumber(query)`; returns
    `{ receipt: { receiptNumber, itemSummary } | null }`.
  - `mode === "serial"` (default) → `searchItemsBySerial(query)` (already caps at
    50); returns `{ items: ItemResult[] }` where
    `ItemResult = { id, make, model, serialNumber, status }`.
  - Return shape is a single discriminated object, e.g.
    `{ items?: ItemResult[]; receipt?: ReceiptHit | null }`.
- **`HomeSearch` component** (rewritten, client): mode `<select>` + a text input
  (no submit button). An `onChange` handler debounces ~250ms, then calls
  `liveSearchAction`. A ref/counter guards against out-of-order responses (only
  the latest query's results are applied). Renders a live results list under the
  input:
  - Serial results → item cards linking to `/i/[id]` (make/model/serial/status).
  - Receipt hit → a single row linking to `/receipts/[receiptNumber]`
    (receiptNumber + itemSummary).
  - Empty query → no list. Non-empty query with no matches → a subtle
    "No matches." line.
- The current `searchAction` (redirect-based) and its tests are removed; the home
  page keeps `<HomeSearch />` (import/markup unchanged aside from the component's
  internals) and its heading/subtitle copy.

### B. Logout redirect

`logoutAction` in `src/app/actions/auth.ts`: change `signOut({ redirectTo:
"/login" })` → `signOut({ redirectTo: "/" })`.

### C. Login "back to search"

`src/app/login/page.tsx`: add a `Link href="/"` labeled "← Back to search" (near
the top of the card, above or below the "Sign in" heading; keep the existing
"Create one"/register link).

## Error handling

- `liveSearchAction` swallows nothing it shouldn't: a blank query returns empty
  results (not an error); a DB error propagates (the client shows the input
  unchanged — acceptable for a type-ahead; no crash surface).
- Out-of-order responses are ignored via a monotonically increasing request id
  compared on resolution.

## Testing

- **Unit:** `liveSearchAction` — blank query → `{ items: [] }`; serial mode maps
  items to `ItemResult[]`; receipt mode returns `{ receipt }` (hit and null).
  (Redirect assertions are gone since the action no longer redirects.)
- **Manual/e2e (documented):** typing a partial serial shows live item results;
  switching to Hand-receipt-number mode and typing a number shows the receipt
  row; clicking a result opens it; signing out lands on `/`; the login page's
  "Back to search" returns to `/`.

## Deployment

Code-only — no migration. Push auto-deploys to prod.
