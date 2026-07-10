# Items page — device name column, sorting, column visibility

**Date:** 2026-07-10
**Status:** Approved

## Goal

On the items list page (`/items`), make the item's device name visible as the
first data column, let the user sort the list by a chosen field in ascending or
descending order, and let the user hide/show columns. Sort and column-visibility
choices persist across reloads.

## Scope

- `src/components/ItemSelectTable.tsx` (client component) — all UI + state.
- `src/app/items/page.tsx` — add `deviceName` to the mapped row objects.

No server, service, schema, or database changes. All items are already loaded
into the client component (no pagination), so sorting and column visibility are
purely client-side.

## Requirements

### 1. Device Name column
- Extend `ItemRow` with `deviceName: string | null` (the DB column is nullable).
- `page.tsx` includes `deviceName: it.deviceName` in the row mapping.
- Device Name is the **first data column** (after the select checkbox), before
  Make. Column order: `[checkbox] · Device Name · Make · Model · Serial · Status · Actions`.
- A null/blank device name renders as a muted em dash (`—`).

### 2. Sorting (client-side)
- A toolbar above the table with:
  - **Sort by** `<select>`: Device Name, Make, Model, Serial, Status.
  - **Direction** toggle button: ascending / descending (with a clear label/glyph).
- Sorting is derived via `useMemo` over the incoming `items`; the original prop
  array is not mutated.
- String comparisons are case-insensitive (`localeCompare`).
- Null/blank values sort **last** regardless of direction.
- Default (before the user picks anything): preserve the server order (newest
  first) — represented as a `null` sort field.

### 3. Column visibility
- A **Columns** control (a `<details>` popover containing one checkbox per data
  column) toggles visibility of: Device Name, Make, Model, Serial, Status.
- The select-checkbox column and the Actions column are always visible.
- At least one data column must remain visible (the last one cannot be unchecked).
- Headers and cells render conditionally on the hidden set.

### 4. Persistence
- `localStorage` keys:
  - `items:sort` → `{ field: string | null, dir: "asc" | "desc" }`
  - `items:hiddenCols` → `string[]` (data-column keys that are hidden)
- Read once in a `useEffect` after mount so first paint uses defaults and avoids
  an SSR hydration mismatch; then apply saved values.
- Write to `localStorage` whenever sort or hidden columns change.
- Reads/writes are wrapped defensively (try/catch, JSON parse guards) so a
  corrupt or unavailable store falls back to defaults.

## Data flow

`page.tsx` (server) loads items → passes rows (existing shape + `deviceName`) to
`ItemSelectTable` → component holds `sort`/`dir`/`hiddenCols` state (hydrated
from `localStorage` post-mount) → derives a sorted array via `useMemo` → renders
headers and cells conditionally on `hiddenCols`. Existing selection and
"create receipt" logic is untouched.

## Out of scope
- Pagination and server-side sorting.
- Reordering columns (only show/hide).
- Persisting preferences server-side / per-user.
