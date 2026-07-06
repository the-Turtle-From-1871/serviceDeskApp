# Consistent Nav Bar — Design

**Date:** 2026-07-06
**Status:** Approved (pending spec review)

## Summary

Make the top nav identical on every app page. Today each page passes its own
links as `AppHeader` children, so the visible set changes page to page. Instead,
render one **role-scoped** set on every page, mark the current page with a colored
active indicator, and keep the nav right-justified on large screens. No schema
change — code-only.

## Decisions (from brainstorming)

- The nav set is **role-scoped** and identical across every page for that viewer
  (gated links the viewer can't reach are simply not shown):
  - **Logged out:** Search · Staff sign in
  - **User:** Search · Items · Account · Sign out
  - **Admin:** Search · Items · New item · Users · Audit · Account · Sign out
- **Active page** gets a colored (indigo accent) **underline** on desktop; in the
  mobile stacked panel it gets a left accent bar + subtle tint.
- Nav stays **right-justified** on large screens (existing `.spacer`).
- Applies to every app page **including** the public `/receipts/[n]` page (which
  has no header today). **Login/register stay minimal** (centered card + "Back to
  search") — unchanged.

## Architecture

### A. `src/components/nav.ts` (plain module — no "use client")

Two pure, unit-testable helpers plus a shared type.

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

Note: no two non-home hrefs are prefixes of one another (`/items` vs
`/admin/items/new` etc.), so at most one item is active. Sign out is a form, not a
nav link — it never carries an active state.

### B. `src/components/SiteHeader.tsx` (new server component)

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

Every app page renders `<SiteHeader />` in place of its hand-written
`<AppHeader>…children…</AppHeader>`. (`auth()` is a cheap JWT decode; pages that
already call it/`requireUser` incur one extra decode — acceptable.)

### C. `src/components/AppHeader.tsx` (refactored client component)

API changes from `children` to `{ items: NavItem[]; loggedIn: boolean; brandHref?: string }`.
Keeps the hamburger `open` state. Uses `usePathname()` for the active check.

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

The hamburger renders unconditionally now (items is always non-empty). `SignOutButton`
moves inside `AppHeader` (was previously passed as a child by each page).

### D. Active-indicator styles (`src/app/globals.css`)

Add to the header/nav CSS (uses the existing tokens `--primary: #4f46e5` and
`--primary-soft: #eef2ff`):
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

## Pages updated

Replace the `<AppHeader>…</AppHeader>` block (and its now-unused per-page `Link`/
`SignOutButton` imports) with `<SiteHeader />` in:
- `src/app/page.tsx` (home)
- `src/app/admin/layout.tsx` (covers all admin pages)
- `src/app/items/page.tsx`
- `src/app/items/[id]/transfer/page.tsx`
- `src/app/i/[itemId]/page.tsx` (supersedes its custom auth-aware header; the
  staff-only "Item details" block and the rest of the page stay)
- `src/app/account/page.tsx`
- **Add** `<SiteHeader />` at the top of `src/app/receipts/[receiptNumber]/page.tsx`
  (wrap its `<main>` in a fragment with the header above it).

`/i/[itemId]` no longer needs its own `auth()` call for the header, but it still
calls `auth()` for the staff detail block — leave that untouched.

## Error handling / edge cases

- Deep admin sub-pages (`/admin/items/[id]/edit`, `/qr`) match no nav item → no
  active highlight there. Acceptable.
- `usePathname()` is always defined in the App Router client context.
- Anonymous viewer on any page → public set (Search · Staff sign in); no Sign out.

## Testing

- **Unit (`src/components/nav.test.ts`):**
  - `navItemsFor`: logged-out set; user set; admin set (exact labels/hrefs/order).
  - `isActive`: `("/", "/")` true; `("/", "/items")` false; `("/items", "/items")`
    true; `("/items", "/items/abc/transfer")` true; `("/items", "/admin/items/new")`
    false; `("/admin/users", "/admin/audit")` false.
- **Browser (controller):** nav identical across home/items/admin/account/receipt
  for a given viewer; active underline tracks the current page and moves on
  navigation; right-justified on desktop (~1000px); hamburger + stacked active
  tint on mobile (~375px); logged-out shows Search + Staff sign in only.
- Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.

## Deployment

Code-only, no migration → plain push.
