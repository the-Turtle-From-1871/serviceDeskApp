# Item Detail View — Design

**Date:** 2026-07-06
**Status:** Approved (pending spec review)

## Summary

Give logged-in staff a complete view of an item: enhance the existing public item
page (`/i/[itemId]`) with a **staff-only "Item details" block** (notes, date
logged, who logged it, current holder), and make the item reachable from the
**Items list** via a new "View" action. The transfer log already on that page is
unchanged. No schema change — code-only.

## Decisions (from brainstorming)

- Enhance the existing `/i/[itemId]` page (not a separate view).
- Add fields: **notes, date logged, logged by, current holder**.
- These fields are **visible only to logged-in viewers**; the public/QR view is
  unchanged (item basics + QR + transfer log with PDFs).
- Add a **"View"** action on the `/items` list (all logged-in users) → `/i/[id]`.

## Architecture

### A. `/i/[itemId]` page (`src/app/i/[itemId]/page.tsx`)

- Read the session via `auth()` (from `@/auth`). `const loggedIn = !!session?.user;`
- Load the item via a new `getItemWithCreator(id)` (below) so `createdBy` is
  available. 404 via `notFound()` if missing (unchanged).
- The public content is unchanged: item make/model/serial/home-unit/status,
  the QR block, and the hand-receipt transfer log (each row From → To, date,
  Download PDF).
- **When `loggedIn`, render an additional "Item details" card** (placed above the
  transfer-log card) with:
  - **Notes** — `item.notes` or "—".
  - **Date logged** — `formatDateTimeHST(item.createdAt)`.
  - **Logged by** — `item.createdBy` as `RANK Name` (or just `Name`); "—" if the
    relation is somehow absent.
  - **Current holder** — the most recent transfer's receiver, formatted with the
    page's existing `partyLabel(...)` helper (`DCSIM · name` or `RANK Name (Unit)`);
    "Not yet transferred" when the item has no completed transfers. Derived from
    the already-fetched `receipts[0]` (list is newest-first) — no extra query.
  - Use the existing `.dl` definition-list styling (which already stacks on mobile).
- **Header:** the current header shows a single "Search" link. Change it so a
  logged-in viewer sees an **"Items"** link (→ `/items`) and **Sign out**; a
  public viewer keeps the **"Search"** link (→ `/`). (Uses the existing
  `AppHeader` + `SignOutButton`.)

### B. "View" action on the Items list (`src/app/items/page.tsx`)

In each row's actions cell, add a **"View"** link as the **first** action (for all
logged-in users), before "Transfer":
```tsx
<Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
```
"View" is added as the first action for all logged-in users; the existing
actions (Transfer, and the admin-gated QR/Edit/Retire) keep their current order
and gating.

### C. Data (`src/modules/items/items.service.ts`)

Add:
```ts
export function getItemWithCreator(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: { createdBy: { select: { rank: true, name: true } } },
  });
}
```
`getItem(id)` is left unchanged for its other callers (transfer page, admin QR
page/route, edit page). The item page switches to `getItemWithCreator`.

## Error handling / edge cases

- Unknown item → `notFound()` (404), unchanged.
- Item with no transfers → transfer log shows its existing empty state; "Current
  holder" shows "Not yet transferred".
- `createdBy` is a required relation (`Item.createdById` is non-null), so it should
  always resolve; render "—" defensively if null.
- The staff block never renders for anonymous visitors (gated on `session?.user`).

## Testing

- **Unit:** `getItemWithCreator` returns the item with the `createdBy` selection
  (mocked-prisma test asserting the `include` shape).
- **Browser (controller):** as a logged-in user, `/items` → "View" opens `/i/[id]`
  showing the "Item details" block (notes/date/logged-by/current holder) + the
  transfer log; header has Items + Sign out. Logged out (private window), the same
  URL shows the public view WITHOUT the details block; header shows "Search".
- Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.

## Deployment

Code-only, no migration → plain push.
