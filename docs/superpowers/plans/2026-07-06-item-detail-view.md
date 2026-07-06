# Item Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give logged-in staff a full item view — enhance `/i/[itemId]` with a staff-only "Item details" block (notes, date logged, logged by, current holder) and add a "View" link from the Items list.

**Architecture:** Add `getItemWithCreator` (includes `createdBy`); the item page reads `auth()` and conditionally renders the details card; the Items list gains a per-row "View" link. No schema change.

**Tech Stack:** Next.js 16 (App Router, Server Components), Prisma 7, Auth.js v5, Vitest.

## Global Constraints

- The public/QR view of `/i/[itemId]` MUST stay unchanged for anonymous visitors; the new "Item details" block renders ONLY when `session?.user` is truthy.
- "Current holder" is the receiver of the newest transfer (`receipts[0]`, already fetched newest-first) — no extra query. "Not yet transferred" when there are none.
- No schema change; code-only deploy (no migration).
- **Commit** after each task's gates pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`. UI verified in-browser (controller).

---

## File Structure

**Modified**
- `src/modules/items/items.service.ts` — add `getItemWithCreator`
- `src/modules/items/items.service.search.test.ts` — test it (mocked prisma)
- `src/app/i/[itemId]/page.tsx` — auth-gated "Item details" block + header
- `src/app/items/page.tsx` — "View" action per row

---

## Task 1: `getItemWithCreator`

**Files:**
- Modify: `src/modules/items/items.service.ts`, `src/modules/items/items.service.search.test.ts`

**Interfaces:**
- Produces: `getItemWithCreator(id): Promise<(Item & { createdBy: { rank: string | null; name: string } }) | null>` — item plus its creator's rank/name.

- [ ] **Step 1: Add the failing test**

`src/modules/items/items.service.search.test.ts` mocks `@/lib/prisma`. Extend the mock to include `findUnique` and add a test. Change the mock line to include `findUnique`:
```ts
vi.mock("@/lib/prisma", () => ({ default: { item: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) } } }));
```
Add (after importing `getItemWithCreator` alongside the existing import):
```ts
import { searchItemsBySerial, getItemWithCreator } from "./items.service";

describe("getItemWithCreator", () => {
  it("looks up by id and includes the creator's rank/name", async () => {
    await getItemWithCreator("itm1");
    const arg = (prisma.item.findUnique as any).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "itm1" });
    expect(arg.include).toEqual({ createdBy: { select: { rank: true, name: true } } });
  });
});
```
(Use the same `as any` / `vi.mocked` style already used in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- items.service.search`
Expected: FAIL — `getItemWithCreator` not exported.

- [ ] **Step 3: Implement**

In `src/modules/items/items.service.ts`, add:
```ts
export function getItemWithCreator(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: { createdBy: { select: { rank: true, name: true } } },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- items.service.search` then `npm test`
Expected: PASS (full suite unchanged otherwise).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.search.test.ts
git commit -m "feat(items): getItemWithCreator (item + creator rank/name)"
```

---

## Task 2: Item detail view (page + list link)

**Files:**
- Modify: `src/app/i/[itemId]/page.tsx`, `src/app/items/page.tsx`

**Interfaces:**
- Consumes: `getItemWithCreator` (Task 1); `auth` (`@/auth`); `SignOutButton`; existing `partyLabel`, `formatDateTimeHST`, `listReceiptsForItem`.

- [ ] **Step 1: Enhance the item page**

Edit `src/app/i/[itemId]/page.tsx`:

Add imports:
```tsx
import { auth } from "@/auth";
import { SignOutButton } from "@/components/SignOutButton";
```
Change the item fetch from `getItem` to `getItemWithCreator` (update the import: `import { getItemWithCreator } from "@/modules/items/items.service";`) and add the session read:
```tsx
  const { itemId } = await params;
  const [item, session] = await Promise.all([getItemWithCreator(itemId), auth()]);
  if (!item) notFound();
  const loggedIn = !!session?.user;
  const [receipts, qr] = await Promise.all([
    listReceiptsForItem(item.id),
    itemQrDataUrl(item.id).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
  ]);
```
Replace the header with an auth-aware one:
```tsx
      <AppHeader brandHref="/">
        {loggedIn ? (
          <>
            <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
            <SignOutButton />
          </>
        ) : (
          <Link href="/" className="btn btn-ghost btn-sm">Search</Link>
        )}
      </AppHeader>
```
Add the staff-only "Item details" card **immediately before** the `{qr && (...)}` block (i.e. right after the `</div>` that closes the title row), so it appears above the QR + transfer log:
```tsx
        {loggedIn && (
          <div className="card">
            <div className="card__title">Item details</div>
            <dl className="dl">
              <dt>Notes</dt>
              <dd>{item.notes || "—"}</dd>
              <dt>Date logged</dt>
              <dd>{formatDateTimeHST(item.createdAt)}</dd>
              <dt>Logged by</dt>
              <dd>{item.createdBy ? (item.createdBy.rank ? `${item.createdBy.rank} ${item.createdBy.name}` : item.createdBy.name) : "—"}</dd>
              <dt>Current holder</dt>
              <dd>
                {receipts.length > 0
                  ? partyLabel({ isDcsim: receipts[0].receiverIsDcsim, name: receipts[0].receiverName, rank: receipts[0].receiverRank, unit: receipts[0].receiverUnit })
                  : "Not yet transferred"}
              </dd>
            </dl>
          </div>
        )}
```

- [ ] **Step 2: Add the "View" action on the Items list**

In `src/app/items/page.tsx`, inside the row's `<div className="actions" …>`, add a "View" link as the FIRST child (before the Transfer link):
```tsx
                        <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
                        {it.status === "ACTIVE" && <Link href={`/items/${it.id}/transfer`} className="btn btn-primary btn-sm">Transfer</Link>}
```
(Leave the admin-gated QR/Edit/Retire actions unchanged.)

- [ ] **Step 3: Verify (gates)**

Run: `npx tsc --noEmit` (0), `npm run lint` (clean), `npm test` (unchanged-green), `npm run build` (succeeds).

- [ ] **Step 4: Commit**

```bash
git add "src/app/i/[itemId]/page.tsx" src/app/items/page.tsx
git commit -m "feat(items): staff-only item detail block on /i; View action on Items list"
```

---

## Task 3: Browser verification

**No code.** Controller verifies in a browser:

- [ ] **Step 1: Full gates** — `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.
- [ ] **Step 2: Verify (record results):**
  1. Logged in as admin: `/items` → each row has a "View" link → opens `/i/[id]` showing the **"Item details"** card (Notes / Date logged / Logged by / Current holder) above the QR + transfer log; header shows Items + Sign out.
  2. Logged out (private window): the same `/i/[id]` URL shows the public view **without** the Item details card; header shows "Search".
  3. An item with no transfers shows "Current holder: Not yet transferred".
- [ ] **Step 3:** Commit any doc note (skip if none).

---

## Self-Review (coverage map)

- **Reachable from Items list** → Task 2 Step 2 (View action).
- **All item fields (notes, date logged, logged by, current holder)** → Task 2 Step 1 (details card) + Task 1 (`getItemWithCreator`).
- **Staff-only visibility** → Task 2 Step 1 (`loggedIn` gate); public view unchanged.
