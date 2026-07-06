# Mobile Responsive Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app phone-friendly: a reusable header with a hamburger menu, data tables that restack into cards on small screens, and mobile spacing polish.

**Architecture:** One client `AppHeader` component (hamburger toggle) replaces 5 hand-written headers; CSS media queries handle the table→card restack and spacing. No behavioral/data changes.

**Tech Stack:** Next.js 16 (App Router, React 19 client components), plain CSS in `globals.css`.

## Global Constraints

- **Breakpoints:** header hamburger at **≤720px**; table→card at **≤640px**. Don't disturb the existing `≤560px` (`.form-grid`) and `≤480px` (`.dl`) rules.
- **No new dependencies** (hamburger icon is three CSS `<span>` bars).
- **Nav items are ghost buttons** (`btn btn-ghost btn-sm`) or `SignOutButton`, uniformly, so `.app-nav` styles them consistently.
- **Accessibility:** the toggle is a real `<button>` with `aria-label="Menu"` and `aria-expanded`.
- **Commit** after each task's gates pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test` (unchanged: 58), `npm run build`. Layout/CSS is verified in-browser (controller), not unit tests.

---

## File Structure

**Created**
- `src/components/AppHeader.tsx` — client header + hamburger

**Modified**
- `src/app/globals.css` — hamburger + `.app-nav` CSS; table→card CSS; mobile spacing; remove now-unused `.nav` rules
- `src/app/admin/layout.tsx`, `src/app/page.tsx`, `src/app/items/page.tsx`, `src/app/items/[id]/transfer/page.tsx`, `src/app/i/[itemId]/page.tsx` — use `AppHeader`
- `src/app/items/page.tsx`, `src/app/admin/users/page.tsx`, `src/app/admin/audit/page.tsx` — `data-label` on `<td>`s
- `src/app/layout.tsx` — `viewport` export

---

## Task 1: Reusable header + hamburger

**Files:**
- Create: `src/components/AppHeader.tsx`
- Modify: `src/app/globals.css`; `admin/layout.tsx`, `page.tsx`, `items/page.tsx`, `items/[id]/transfer/page.tsx`, `i/[itemId]/page.tsx`

**Interfaces:**
- Produces: `AppHeader({ brandHref?: string; children?: React.ReactNode })` — renders the `.app-header` bar with brand, hamburger (≤720px), and the collapsible `.app-nav` wrapping `children`.

- [ ] **Step 1: Create the AppHeader component**

Create `src/components/AppHeader.tsx`:
```tsx
"use client";
import { useState } from "react";
import Link from "next/link";

export function AppHeader({ brandHref = "/", children }: { brandHref?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href={brandHref} className="brand" onClick={close}>
          <span className="brand__mark">HR</span>
          Hand Receipt
        </Link>
        <span className="spacer" />
        {children != null && (
          <button
            type="button"
            className="nav-toggle"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="nav-toggle__bar" />
            <span className="nav-toggle__bar" />
            <span className="nav-toggle__bar" />
          </button>
        )}
        {/* Tapping a link (or anywhere in the panel) closes the menu. */}
        <div className={`app-nav${open ? " app-nav--open" : ""}`} onClick={close}>
          {children}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Add the header/hamburger CSS**

In `src/app/globals.css`, replace the `.nav`/`.nav a` block (lines ~165–182, the `/* ---------- App header / nav ---------- */` region's nav rules) with the `.app-nav`/`.nav-toggle` rules below. Keep `.app-header`, `.app-header__inner`, `.brand`, `.brand__mark` as-is.
```css
.app-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.nav-toggle {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
}
.nav-toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
}
.nav-toggle__bar {
  width: 18px;
  height: 2px;
  border-radius: 2px;
  background: var(--text);
}

@media (max-width: 720px) {
  .app-header__inner { flex-wrap: wrap; }
  .nav-toggle { display: inline-flex; }
  .app-nav {
    flex-basis: 100%;
    display: none;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding-top: 8px;
  }
  .app-nav--open { display: flex; }
  .app-nav .btn { width: 100%; }
  .app-nav form { width: 100%; }
}
```

- [ ] **Step 3: Migrate the admin layout header**

In `src/app/admin/layout.tsx`: replace the whole `<header>…</header>` block with `AppHeader`, converting the plain `<nav>` links to ghost buttons and moving Account + Sign out inside. Add `import { AppHeader } from "@/components/AppHeader";` (keep `Link`, `SignOutButton`).
```tsx
      <AppHeader brandHref="/items">
        <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
        <Link href="/admin/items/new" className="btn btn-ghost btn-sm">New item</Link>
        <Link href="/admin/users" className="btn btn-ghost btn-sm">Users</Link>
        <Link href="/admin/audit" className="btn btn-ghost btn-sm">Audit</Link>
        <Link href="/account" className="btn btn-ghost btn-sm">Account</Link>
        <SignOutButton />
      </AppHeader>
```
(Leave the `<main className="container">{children}</main>` below it unchanged.)

- [ ] **Step 4: Migrate the home header**

In `src/app/page.tsx`: replace the `<header>…</header>` with (keep the `session`/`isAdmin` logic):
```tsx
      <AppHeader brandHref="/">
        {session?.user ? (
          <>
            <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
            {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Admin</Link>}
            <SignOutButton />
          </>
        ) : (
          <Link href="/login" className="btn btn-ghost btn-sm">Staff sign in</Link>
        )}
      </AppHeader>
```
Add `import { AppHeader } from "@/components/AppHeader";`. `page.tsx` is a server component; passing these children to the client `AppHeader` is fine.

- [ ] **Step 5: Migrate the items header**

In `src/app/items/page.tsx`: replace the `<header>…</header>` with:
```tsx
      <AppHeader brandHref="/">
        {isAdmin && <Link href="/admin/items/new" className="btn btn-ghost btn-sm">Log new item</Link>}
        {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Users</Link>}
        {isAdmin && <Link href="/admin/audit" className="btn btn-ghost btn-sm">Audit</Link>}
        <SignOutButton />
      </AppHeader>
```
Add the `AppHeader` import.

- [ ] **Step 6: Migrate the item-transfer header**

In `src/app/items/[id]/transfer/page.tsx`: replace the `<header>…</header>` with:
```tsx
      <AppHeader brandHref="/">
        <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
        <SignOutButton />
      </AppHeader>
```
Add the `AppHeader` import.

- [ ] **Step 7: Migrate the public item header**

In `src/app/i/[itemId]/page.tsx`: replace the `<header>…</header>` with:
```tsx
      <AppHeader brandHref="/">
        <Link href="/" className="btn btn-ghost btn-sm">Search</Link>
      </AppHeader>
```
Add the `AppHeader` import.

- [ ] **Step 8: Verify (gates)**

Run: `npx tsc --noEmit` (0), `npm run lint` (clean), `npm test` (58 pass), `npm run build` (succeeds). `git grep -n "className=\"nav\"" -- src` → no matches (old nav wrapper gone).

- [ ] **Step 9: Commit**

```bash
git add src/components/AppHeader.tsx src/app/globals.css src/app/admin/layout.tsx src/app/page.tsx src/app/items/page.tsx "src/app/items/[id]/transfer/page.tsx" "src/app/i/[itemId]/page.tsx"
git commit -m "feat(mobile): reusable AppHeader with hamburger menu; consolidate 5 headers"
```

---

## Task 2: Table cards + spacing + viewport

**Files:**
- Modify: `src/app/globals.css`; `src/app/items/page.tsx`, `src/app/admin/users/page.tsx`, `src/app/admin/audit/page.tsx`; `src/app/layout.tsx`

- [ ] **Step 1: Add the table→card + spacing CSS**

Append to `src/app/globals.css`:
```css
/* ---------- Mobile: tables restack into cards, tighter spacing ---------- */
@media (max-width: 640px) {
  .table thead { display: none; }
  .table,
  .table tbody,
  .table tr,
  .table td { display: block; width: 100%; }
  .table tr { border-bottom: 8px solid var(--bg); }
  .table tbody tr:last-child { border-bottom: none; }
  .table td {
    border: none;
    padding: 8px 14px;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    align-items: baseline;
  }
  .table td::before {
    content: attr(data-label);
    flex: 0 0 auto;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .table td[data-label=""]::before { content: none; }
  .table td[data-label=""] { justify-content: flex-start; }
  .table .actions { justify-content: flex-start; flex-wrap: wrap; }

  .container { padding: 20px 14px 56px; }
  .app-header__inner { padding: 12px 14px; }
}
```

- [ ] **Step 2: Label the items table cells**

In `src/app/items/page.tsx`, add `data-label` to each `<td>` in the item row:
```tsx
                    <td data-label="Make">{it.make}</td>
                    <td data-label="Model">{it.model}</td>
                    <td className="mono" data-label="Serial">{it.serialNumber}</td>
                    <td data-label="Status"><StatusBadge status={it.status} /></td>
                    <td data-label="">
                      {/* existing .actions div unchanged */}
```
(Only add the attributes; leave the cell contents/actions as-is.)

- [ ] **Step 3: Label the users table cells**

In `src/app/admin/users/page.tsx`, add `data-label` to each `<td>`:
```tsx
                  <td data-label="Name">{u.rank ? `${u.rank} ` : ""}{u.name}{isSelf && <span className="subtle"> (you)</span>}</td>
                  <td className="mono" data-label="Email">{u.email}</td>
                  <td data-label="Role">{/* role badge unchanged */}</td>
                  <td data-label="Active">{/* active badge unchanged */}</td>
                  <td data-label="">{/* actions div unchanged */}</td>
```

- [ ] **Step 4: Label the audit table cells**

In `src/app/admin/audit/page.tsx`, add `data-label` to each `<td>`:
```tsx
                <td data-label="Receipt"><Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link></td>
                <td data-label="Item">{t.itemSummary}</td>
                <td data-label="From">{partyLabel(t.senderIsDcsim, t.senderName, t.senderRank)}</td>
                <td data-label="To">{partyLabel(t.receiverIsDcsim, t.receiverName, t.receiverRank)}</td>
                <td className="subtle" data-label="Date">{formatDateTimeHST(t.createdAt)}</td>
                <td data-label="Status"><StatusBadge status={t.status} /></td>
```

- [ ] **Step 5: Add an explicit viewport**

In `src/app/layout.tsx`, add (import `Viewport` from `next` alongside `Metadata`):
```tsx
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
```

- [ ] **Step 6: Verify (gates)**

Run: `npx tsc --noEmit` (0), `npm run lint` (clean), `npm test` (58 pass), `npm run build` (succeeds).

- [ ] **Step 7: Commit**

```bash
git add src/app/globals.css src/app/items/page.tsx src/app/admin/users/page.tsx src/app/admin/audit/page.tsx src/app/layout.tsx
git commit -m "feat(mobile): tables restack to cards on phones; mobile spacing + explicit viewport"
```

---

## Task 3: Browser verification

**No code.** The controller (or a human) verifies in a browser at phone (~375px) and tablet (~768px) widths:

- [ ] **Step 1: Full gates** — `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.
- [ ] **Step 2: Mobile smoke (record results):**
  1. At ~375px: header shows the hamburger; tapping it opens a stacked menu; tapping a link navigates and closes the menu; brand tap closes it.
  2. `/items`, `/admin/users`, `/admin/audit` render each row as a labelled card (no sideways scroll); action buttons wrap.
  3. Home search, `/i/[id]`, a receipt page, and the transfer/new-item/login/register forms read cleanly with no horizontal page scroll.
  4. At ~768px (desktop-ish) the header shows inline links and tables show normal rows (nothing regressed).
- [ ] **Step 3:** Commit any doc note (skip if none).

---

## Self-Review (coverage map)

- **Hamburger header, collapses on mobile** → Task 1 (`AppHeader` + `@media ≤720px`).
- **Consolidate 5 duplicated headers** → Task 1 Steps 3–7.
- **Tables → cards on phones** → Task 2 Steps 1–4 (`data-label` + `@media ≤640px`).
- **Spacing polish + viewport** → Task 2 Steps 1, 5.
- **Verification** → Task 3 (browser at mobile/tablet widths).
