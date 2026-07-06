# Mobile Responsive Overhaul — Design

**Date:** 2026-07-06
**Status:** Approved (pending spec review)

## Summary

Make the app usable and polished on phones. Three areas:

1. **Reusable header with a hamburger menu** — replace the 5 hand-written page
   headers with one client `AppHeader`; on narrow screens the nav collapses
   behind a hamburger that toggles a stacked panel.
2. **Tables → stacked cards on phones** — the three data tables restack into
   labelled cards below a breakpoint (CSS `data-label` pattern, one markup).
3. **Global spacing / viewport polish** — tighter padding on small screens,
   explicit `viewport`, verified tap targets and no horizontal overflow.

Already responsive (no change): `.form-grid` (1 col ≤560px), `.dl` (stacks
≤480px), `.table-wrap` (h-scroll), `.sigpad` (fluid). Code-only; no migration.

## Breakpoints

- **Header hamburger:** collapse at **≤720px** (the admin header has the most items).
- **Table → cards:** restack at **≤640px**.
- Reuse the existing `≤560px`/`≤480px` form/dl rules as-is.

## 1. `AppHeader` (client component)

New file `src/components/AppHeader.tsx`:
- Props: `brandHref?: string` (default `"/"`), `children?: React.ReactNode` (the
  nav links/buttons/labels the page provides).
- Renders `header.app-header > .app-header__inner`: the brand link, a spacer, a
  hamburger `<button class="nav-toggle">` (three bars), and a
  `<div class="app-nav">` wrapping `children`.
- State: `open` (useState). The toggle flips it; `aria-expanded={open}`,
  `aria-label="Menu"`. Clicking the brand or anywhere in the nav panel sets
  `open=false` (so tapping a link closes the menu).
- The three hamburger bars are `<span>`s styled in CSS (no icon dependency).

CSS (in `globals.css`):
- `.app-header__inner` gains `flex-wrap: wrap` so the panel can drop to a full
  width row on mobile.
- `.nav-toggle` (button): hidden by default (`display: none`); three-bar icon via
  child spans; ≥40px tap target.
- `.app-nav`: desktop = `display: flex; align-items: center; gap: 4px;
  flex-wrap: wrap` (inline links, as today).
- `@media (max-width: 720px)`: `.nav-toggle { display: inline-flex }`;
  `.app-nav { flex-basis: 100%; display: none }`; `.app-nav--open { display:
  flex; flex-direction: column; align-items: stretch; gap: 4px; padding-top:
  8px }`. Stacked links/buttons go full width (`.app-nav .btn { width: 100% }`,
  nav links become block).

**Replace these 5 headers** with `<AppHeader brandHref=…>…children…</AppHeader>`,
passing each page's existing links/buttons as children (dropping the ad-hoc
`<span className="spacer" />` and inner `<nav className="nav">` wrappers, which
`AppHeader` now owns):
- `src/app/admin/layout.tsx` (brand `/items`; children: Items, New item, Users,
  Audit, Account, Sign out).
- `src/app/page.tsx` (brand `/`; children: logged-in → Items, Admin (if admin),
  Sign out; logged-out → Staff sign in).
- `src/app/items/page.tsx` (brand `/`; children: admin → Log new item, Users,
  Audit; Sign out).
- `src/app/items/[id]/transfer/page.tsx` (brand `/`; children: Items, Sign out).
- `src/app/i/[itemId]/page.tsx` (brand `/`; children: Search).

`SignOutButton` (already a client component rendering a server-action form) is
passed as a child unchanged. `AppHeader` renders `{children}` — server-rendered
Links/buttons pass through fine.

## 2. Tables → stacked cards (≤640px)

CSS in `globals.css` (scoped so it only affects `.table` inside `.table-wrap`):
```css
@media (max-width: 640px) {
  .table thead { display: none; }
  .table, .table tbody, .table tr, .table td { display: block; width: 100%; }
  .table tr { border-bottom: 8px solid var(--bg); }
  .table td { border: none; padding: 8px 14px; display: flex; gap: 12px;
    justify-content: space-between; align-items: baseline; }
  .table td::before { content: attr(data-label); font-weight: 600; font-size: 12px;
    text-transform: uppercase; color: var(--text-muted); flex: 0 0 auto; }
  .table td[data-label=""]::before { content: none; } /* actions cell: no label */
  .table td:empty { display: none; }
  .table .actions { justify-content: flex-start; }
}
```
Add a `data-label="Make"` (etc.) attribute to every data `<td>` in the three
tables so the card rows show the column name. The actions cell gets an explicit
`data-label=""` so its `::before` is suppressed and the buttons span the row.

**Files:** `src/app/items/page.tsx`, `src/app/admin/users/page.tsx`,
`src/app/admin/audit/page.tsx` — add `data-label` to each `<td>`. Keep the
`.table-wrap` wrapper (harmless when stacked).

## 3. Global polish

- `src/app/layout.tsx`: add `export const viewport: Viewport = { width: "device-width", initialScale: 1 };`
  (explicit; Next already injects the default).
- `globals.css`: on `@media (max-width: 640px)`, reduce `.container` padding to
  `20px 14px 56px` and `.app-header__inner` padding to `12px 14px`.
- Verify tap targets: `.btn` (40px) / `.btn-sm` (32px) are acceptable; the
  hamburger button is ≥40px. No change unless something is too small.

## Error handling / edge cases

- Menu state is client-only; SSR renders it closed (no hydration mismatch since
  `open` starts `false`).
- Public pages (`/`, `/i`) with 1 nav item still get the hamburger for
  consistency; acceptable (a single stacked link).

## Testing

- No unit tests (pure CSS/layout + a stateful toggle). Verify in-browser
  (Playwright) at ~375px (phone) and ~768px (tablet):
  - hamburger appears ≤720px, opens/closes, links navigate + close the menu;
  - the three tables render as labelled cards ≤640px;
  - forms stack, search/receipt/item cards read cleanly, no horizontal page
    scroll at 360px.
- Gates: `npx tsc --noEmit`, `npm run lint`, `npm test` (unchanged), `npm run build`.

## Deployment

Code-only, no migration → plain push.
