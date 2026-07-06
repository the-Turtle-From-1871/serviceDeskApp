# Consistent Nav Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one role-scoped nav set on every app page with a colored active-page indicator, right-justified on desktop.

**Architecture:** Pure `nav.ts` helpers (`navItemsFor`, `isActive`) → server `SiteHeader` (reads `auth()`) → refactored client `AppHeader` (takes `items` + `loggedIn`, active state via `usePathname()`). Every page renders `<SiteHeader />`. No schema change.

**Tech Stack:** Next.js 16 (App Router, Server + Client Components), Vitest.

## Global Constraints

- Nav sets (identical on every page for that viewer):
  - Logged out: **Search · Staff sign in**
  - User: **Search · Items · Account · Sign out**
  - Admin: **Search · Items · New item · Users · Audit · Account · Sign out**
- Active item: indigo underline on desktop (`--primary`); left accent + `--primary-soft` tint on mobile (≤720px). Nav right-justified on desktop (existing `.spacer`).
- Applies to all app pages **including** `/receipts/[n]`; login/register unchanged.
- **Commit** after each task's gates pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`. UI verified in-browser (controller).

---

## File Structure

**Created**
- `src/components/nav.ts` — pure helpers + `NavItem` type
- `src/components/nav.test.ts` — unit tests
- `src/components/SiteHeader.tsx` — server component

**Modified**
- `src/components/AppHeader.tsx` — new `items`/`loggedIn` API + active state
- `src/app/globals.css` — `.nav-link.is-active` styles
- `src/app/page.tsx`, `src/app/admin/layout.tsx`, `src/app/items/page.tsx`, `src/app/items/[id]/transfer/page.tsx`, `src/app/i/[itemId]/page.tsx`, `src/app/account/page.tsx` — use `<SiteHeader />`
- `src/app/receipts/[receiptNumber]/page.tsx` — add `<SiteHeader />`

---

## Task 1: `nav.ts` helpers

**Files:**
- Create: `src/components/nav.ts`, `src/components/nav.test.ts`

**Interfaces:**
- Produces: `type NavItem = { label: string; href: string }`; `navItemsFor({ loggedIn, isAdmin }): NavItem[]`; `isActive(href, pathname): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/components/nav.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { navItemsFor, isActive } from "./nav";

describe("navItemsFor", () => {
  it("logged out: Search + Staff sign in", () => {
    expect(navItemsFor({ loggedIn: false, isAdmin: false })).toEqual([
      { label: "Search", href: "/" },
      { label: "Staff sign in", href: "/login" },
    ]);
  });
  it("user: Search, Items, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: false })).toEqual([
      { label: "Search", href: "/" },
      { label: "Items", href: "/items" },
      { label: "Account", href: "/account" },
    ]);
  });
  it("admin: Search, Items, New item, Users, Audit, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true })).toEqual([
      { label: "Search", href: "/" },
      { label: "Items", href: "/items" },
      { label: "New item", href: "/admin/items/new" },
      { label: "Users", href: "/admin/users" },
      { label: "Audit", href: "/admin/audit" },
      { label: "Account", href: "/account" },
    ]);
  });
});

describe("isActive", () => {
  it("home matches only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/items")).toBe(false);
  });
  it("non-home matches self and subtree", () => {
    expect(isActive("/items", "/items")).toBe(true);
    expect(isActive("/items", "/items/abc/transfer")).toBe(true);
    expect(isActive("/items", "/admin/items/new")).toBe(false);
    expect(isActive("/admin/users", "/admin/audit")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- components/nav`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement**

Create `src/components/nav.ts`:
```ts
export type NavItem = { label: string; href: string };

export function navItemsFor({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const search: NavItem = { label: "Search", href: "/" };
  if (!loggedIn) return [search, { label: "Staff sign in", href: "/login" }];
  const items: NavItem[] = [search, { label: "Items", href: "/items" }];
  if (isAdmin) {
    items.push(
      { label: "New item", href: "/admin/items/new" },
      { label: "Users", href: "/admin/users" },
      { label: "Audit", href: "/admin/audit" },
    );
  }
  items.push({ label: "Account", href: "/account" });
  return items;
}

// Home ("/") matches only exactly; every other item matches its subtree.
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- components/nav` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/nav.ts src/components/nav.test.ts
git commit -m "feat(nav): pure navItemsFor + isActive helpers"
```

---

## Task 2: SiteHeader + AppHeader refactor + adopt everywhere

**Files:**
- Create: `src/components/SiteHeader.tsx`
- Modify: `src/components/AppHeader.tsx`, `src/app/globals.css`, and 7 page/layout files (below)

**Interfaces:**
- Consumes: `navItemsFor`, `isActive`, `NavItem` (Task 1); `auth` (`@/auth`); `SignOutButton`.
- Produces: `SiteHeader()` (async server component, no props); `AppHeader({ items, loggedIn, brandHref? })`.

> NOTE: AppHeader's API change breaks every current `<AppHeader>…children…</AppHeader>`
> call, so all page edits below MUST land together for the build to pass. Do all
> steps, then run gates once at the end.

- [ ] **Step 1: Refactor `AppHeader`**

Replace the entire contents of `src/components/AppHeader.tsx`:
```tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";
import { isActive, type NavItem } from "@/components/nav";

export function AppHeader({ items, loggedIn, brandHref = "/" }: { items: NavItem[]; loggedIn: boolean; brandHref?: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pathname = usePathname();
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href={brandHref} className="brand" onClick={close}>
          <span className="brand__mark">HR</span>
          Hand Receipt
        </Link>
        <span className="spacer" />
        <button type="button" className="nav-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="nav-toggle__bar" />
          <span className="nav-toggle__bar" />
          <span className="nav-toggle__bar" />
        </button>
        <div className={`app-nav${open ? " app-nav--open" : ""}`} onClick={close}>
          {items.map((it) => {
            const active = isActive(it.href, pathname);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`btn btn-ghost btn-sm nav-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {it.label}
              </Link>
            );
          })}
          {loggedIn && <SignOutButton />}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Create `SiteHeader`**

Create `src/components/SiteHeader.tsx`:
```tsx
import { auth } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { navItemsFor } from "@/components/nav";

export async function SiteHeader() {
  const session = await auth();
  const loggedIn = !!session?.user;
  const isAdmin = session?.user?.role === "ADMIN";
  return <AppHeader items={navItemsFor({ loggedIn, isAdmin })} loggedIn={loggedIn} />;
}
```

- [ ] **Step 3: Add the active-indicator CSS**

In `src/app/globals.css`, in the header/nav region, add:
```css
.nav-link.is-active {
  color: var(--primary);
  box-shadow: inset 0 -2px 0 var(--primary);
  border-radius: 0;
}
@media (max-width: 720px) {
  /* Underline reads oddly stacked; use a left accent + tint instead. */
  .app-nav .nav-link.is-active {
    box-shadow: none;
    border-left: 3px solid var(--primary);
    background: var(--primary-soft);
    border-radius: var(--radius-sm);
  }
}
```

- [ ] **Step 4: Replace headers with `<SiteHeader />` in 6 files**

In each file: add `import { SiteHeader } from "@/components/SiteHeader";`, replace the header block with `<SiteHeader />`, and delete imports that become unused (`AppHeader`, and `SignOutButton`/`Link` where no longer referenced — keep `Link` where the page still uses it elsewhere). Leave all non-header logic untouched.

- **`src/app/page.tsx`** — replace the whole `<AppHeader>…</AppHeader>` with `<SiteHeader />`. The `session`/`isAdmin` computation existed only for the header — remove it and the `auth`, `Link`, `SignOutButton`, `AppHeader` imports (HomeSearch stays). Result body is just `<SiteHeader />` + the existing `<main>`.
- **`src/app/admin/layout.tsx`** — replace `<AppHeader brandHref="/items">…</AppHeader>` with `<SiteHeader />`. Remove `Link`, `SignOutButton`, `AppHeader` imports. Keep the `requireAdmin` try/catch and `<main className="container">{children}</main>`.
- **`src/app/items/page.tsx`** — replace `<AppHeader>…</AppHeader>` with `<SiteHeader />`. Remove `SignOutButton`, `AppHeader` imports. **Keep `Link`** (used by the row actions) and `isAdmin` (used by the table).
- **`src/app/items/[id]/transfer/page.tsx`** — replace `<AppHeader brandHref="/">…</AppHeader>` with `<SiteHeader />`. Remove `Link`, `SignOutButton`, `AppHeader` imports (Link is only in the header here). Keep everything else.
- **`src/app/i/[itemId]/page.tsx`** — replace the auth-aware `<AppHeader>…</AppHeader>` block with `<SiteHeader />`. Remove `SignOutButton`, `AppHeader` imports. **Keep `Link`** (receipt links), **keep the `auth()` call and `loggedIn`** (used by the staff "Item details" block). Only the header markup changes.
- **`src/app/account/page.tsx`** — replace the raw `<header className="app-header">…</header>` block with `<SiteHeader />`. Remove `SignOutButton` import and `Link` import **if** `Link` is unused after the change (it's only in the header — verify no other use below), and drop the now-unused `home` variable if it was only used by the header. Keep `requireUser`, `ChangePasswordForm`, and `<main>`.

- [ ] **Step 5: Add `<SiteHeader />` to the receipt page**

In `src/app/receipts/[receiptNumber]/page.tsx`, wrap the return in a fragment with the header above `<main>`:
```tsx
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        {/* …existing content unchanged… */}
      </main>
    </>
  );
```
Add `import { SiteHeader } from "@/components/SiteHeader";`. Keep the existing `Link` import (used by "Search another").

- [ ] **Step 6: Verify (gates)**

Run: `npx tsc --noEmit` (0), `npm run lint` (0 errors; pre-existing warnings ok), `npm test` (Task 1 tests + prior suite green), `npm run build` (succeeds). Also `git grep -n "AppHeader" -- src/app` → no matches (no page imports AppHeader directly anymore; only SiteHeader does).

- [ ] **Step 7: Commit**

```bash
git add src/components/AppHeader.tsx src/components/SiteHeader.tsx src/app/globals.css src/app/page.tsx src/app/admin/layout.tsx src/app/items/page.tsx "src/app/items/[id]/transfer/page.tsx" "src/app/i/[itemId]/page.tsx" src/app/account/page.tsx "src/app/receipts/[receiptNumber]/page.tsx"
git commit -m "feat(nav): consistent role-scoped SiteHeader with active indicator across all pages"
```

---

## Task 3: Browser verification

**No code.** Controller verifies in a browser:

- [ ] **Step 1: Full gates** — `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.
- [ ] **Step 2: Verify (record results):**
  1. Logged in as admin: the nav is identical (Search · Items · New item · Users · Audit · Account · Sign out) on `/items`, `/admin/users`, `/admin/audit`, `/account`, `/i/[id]`, and a `/receipts/[n]` page; the active underline is on the current page's item and moves as you navigate.
  2. Desktop (~1000px): nav right-justified.
  3. Mobile (~375px): hamburger; open panel shows the active item with the left-accent tint.
  4. Logged out (private window): every page (home, `/i/[id]`, `/receipts/[n]`) shows only Search · Staff sign in; Search is active on home.
- [ ] **Step 3:** Commit any doc note (skip if none).

---

## Self-Review (coverage map)

- **Consistent set across pages** → Task 2 (SiteHeader on all 7 files) + Task 1 (`navItemsFor`).
- **Active indicator (underline/highlight)** → Task 2 Steps 1, 3 (`isActive` + CSS).
- **Right-justified on desktop** → preserved via existing `.spacer` (Task 2 Step 1 keeps it).
- **Role-scoped gating** → Task 1 `navItemsFor`.
- **Receipt page gets a header** → Task 2 Step 5.
