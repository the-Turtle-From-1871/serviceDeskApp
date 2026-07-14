# Editable Item Details + Edit History — Design

**Date:** 2026-07-14
**Status:** Approved (design), ready for implementation plan

## Summary

Let any authenticated user (not just admins) edit four item fields from the item
detail page: **Home unit**, **Device Name**, **Current user**, and **Current
position**. Editing happens inline via an **Edit button in the top-right of the
"Item details" card**. The unit field is a searchable dropdown backed by the
`Unit` table. Every edit is recorded in a new `ItemEdit` history table and
surfaced on `/admin/audit`.

## Key decisions (resolved during brainstorming)

1. **"Current user" is a NEW stored field, and the derived holder stays.** The
   existing "Current holder" row is *derived* at render time from the most recent
   `OPEN` hand receipt (`src/app/i/[itemId]/page.tsx:30`) — it is the signed
   custody record. It is **not** made editable. Instead it is relabeled
   **"Hand-receipt holder"** and a separate, editable **"Current user"** field
   records who is actually using the device. This keeps the DA-2062 custody chain
   authoritative while allowing practical assignment tracking.
2. **"Current position"** = the current user's role/billet (e.g. "Supply
   Sergeant"). Free text, pairs with Current user.
3. **Any active authenticated user may edit, on any item.** Inventory is shared
   org-wide; there is no ownership model. Admins included.
4. **Full edit history**, not just a last-editor stamp: a new `ItemEdit` table
   retains every edit and what changed.
5. **The admin edit page is left as-is.** `/admin/items/[itemId]/edit` continues
   to edit make/model/serialNumber/deviceName/homeUnit/notes. `deviceName` and
   `homeUnit` are therefore editable in two places — accepted, and both paths log
   history via a shared service.

## Current state (verified)

- `Item` has `make, model, serialNumber, homeUnit String?, deviceName String?,
  notes String?, status, createdById`. No `currentUser`/`currentPosition`.
- `homeUnit` is **not** shown in the "Item details" card — it appears only in the
  page subtitle next to the serial (`page.tsx:38`). It stores the unit's
  **fullName** (what `detectHomeUnit` resolves to).
- "Current holder" is derived: `receipts.find((t) => t.status === "OPEN")` →
  `formatParty(receiver)`.
- Editing is admin-only today: `updateItemAction`
  (`src/app/admin/actions/items.ts`) calls `requireAdmin()`.
- `Unit` table: `abbreviation` (unique) + `fullName`; 71 HIARNG units seeded.
  `loadUnitMap()` in `src/modules/items/units.service.ts`.
- **No generic audit-log table exists.** `/admin/audit` assembles its view from
  `Transfer`, `ImportBatch`, and `ReturnTransaction`.
- **Searchable-dropdown precedent:** `src/app/admin/users/NewUserForm.tsx` uses
  `<input list>` + `<datalist>` (ranks, via `src/lib/ranks.ts`) — free text with
  suggestions.
- Dead CSS: a `.combo` block at `src/app/globals.css:473` from the deleted
  `UserCombobox`. Out of scope; noted only.

## Data model

```prisma
model Item {
  // ...existing fields...
  currentUser     String?   // person actually using the device
  currentPosition String?   // that person's role/billet
  edits           ItemEdit[]
}

// History of edits to an item's user-editable fields. One row per save that
// actually changed something.
model ItemEdit {
  id           String   @id @default(cuid())
  item         Item     @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId       String
  editedBy     User?    @relation("ItemEdits", fields: [editedById], references: [id], onDelete: SetNull)
  editedById   String?
  editedByName String   // denormalized snapshot; survives user deletion
  changes      Json     // [{ field, from, to }] — only fields that changed
  createdAt    DateTime @default(now())

  @@index([itemId])
  @@index([createdAt])
}
```

- `User` gains `itemEdits ItemEdit[] @relation("ItemEdits")`.
- **`editedById` nullable + `SetNull` plus an `editedByName` snapshot** follows the
  existing `ReturnTransaction` precedent (`processedByUserId` SET NULL +
  `processedByName`). This matters concretely: users do get deleted (two were
  removed on 2026-07-14), and without the snapshot their history would render
  as "—".
- `changes` as `Json` follows the `ImportBatch.skipped` precedent.

### Migration

Additive only — two nullable columns on `Item` plus a new `ItemEdit` table. No
data loss, no backfill. Applied to prod via the Supabase MCP + recorded in
`_prisma_migrations` (see [[live-hosting]]; `prisma migrate dev` cannot run in
this environment — use `migrate diff --script` + `migrate deploy`).

## Components

### A. Shared update service — `src/modules/items/items.service.ts`

- `type ItemLoggedFields = { homeUnit, deviceName, currentUser, currentPosition,
  make, model, serialNumber, notes }` — every field whose changes are worth
  logging. Callers pass any **subset**.
- `diffItemFields(before, after: Partial<ItemLoggedFields>): { field, from, to }[]`
  — **pure**, returns only genuinely changed fields (normalized: trimmed,
  `"" → null`), ignoring keys the caller did not pass. Unit-testable with no DB.
- `updateItemFields(itemId, data: Partial<ItemLoggedFields>, editor: { id, name }):
  Promise<Item>` — inside a `$transaction`: load current, compute the diff, update
  the Item, and insert one `ItemEdit` **only if the diff is non-empty** (a no-op
  save writes no history).
- **The service enforces no permissions.** It logs whoever the caller says the
  editor is; access control lives in the actions (C and D), matching how the rest
  of the codebase splits action-guards from services.

### B. Validation — `src/modules/items/items.schema.ts`

- `itemDetailsSchema` — Zod object for the four fields; all optional, trimmed,
  empty-string → undefined (mirrors the existing `optional` helper in that file).

### C. User-level action — `src/app/actions/items.ts` (new file)

- `updateItemDetailsAction(_prev, formData)` — `requireUser()` first; Zod-parse;
  call `updateItemFields(...)` with the session user as editor; `revalidatePath`
  the item page. Returns `{ ok }` or a generic `{ error }`, logging details
  server-side. Placed alongside the other user-level actions
  (`src/app/actions/receipts.ts`), distinct from the admin-only
  `src/app/admin/actions/items.ts`.

### D. Admin action also logs — `src/app/admin/actions/items.ts`

- `updateItemAction` is refactored to route **all** of its fields
  (make/model/serialNumber/deviceName/homeUnit/notes) through the same
  `updateItemFields`, so admin edits land in the same history and stay atomic in
  one transaction. `requireAdmin()` and its existing Zod schema are unchanged —
  only the write path moves.
- The two actions differ solely in their guard and their permitted field set: the
  user action (C) accepts the four fields, the admin action accepts its six. Both
  share one write+log path, so there is exactly one place that records history.

### E. Unit list — `src/modules/items/units.service.ts`

- `listUnits(): Promise<{ abbreviation, fullName }[]>` — ordered by `fullName`,
  for the datalist.

### F. Item detail page — `src/app/i/[itemId]/page.tsx`

- Fetch `listUnits()` and the latest `ItemEdit` alongside the existing
  `Promise.all`.
- "Item details" card title row becomes a flex row: title left, **Edit button
  right** (logged-in users only).
- Card rows (logged-in): Device Name · **Home unit** (new to this card) ·
  **Current user** · **Current position** · Notes (admin only) · Date logged ·
  Logged by · **Hand-receipt holder** (renamed, still derived/read-only) · **Last
  edited** ("by X on Y", from the latest `ItemEdit`; omitted if never edited).

### G. Inline edit form — `src/app/i/[itemId]/ItemDetailsForm.tsx` (new, client)

- Rendered in place of the card's `<dl>` when Edit is toggled; Save + Cancel.
- Fields: Device Name (text), Home unit (`<input list="unit-options">` +
  `<datalist>` of units), Current user (text), Current position (text).
- Uses `useActionState(updateItemDetailsAction, undefined)`; shows the returned
  error or a success state; Cancel restores the read-only view.
- **Unit picker:** native `<datalist>`, matching the `NewUserForm` ranks pattern —
  substring search and keyboard accessibility for free. Deliberately *not* a
  hand-rolled combobox (the previous `UserCombobox` was deleted partly for
  keyboard-a11y defects). Free text remains allowed, consistent with `homeUnit`
  being free text and with the import's unit auto-detect/learn flow.
  `<option value={fullName}>{abbreviation}</option>` so the stored value stays the
  fullName while the abbreviation shows as a hint.

### H. Audit surface — `src/app/admin/audit/page.tsx`

- New "Item edits" section (most recent 50): Date · By (`editedByName`) · Item
  (link to `/i/<id>`) · Changed (field: from → to). Mirrors the existing "CSV
  imports" / "Property returns" sections on that page.

## Testing

- **Pure unit:** `diffItemFields` — only-changed fields returned; no-op → empty;
  trim/empty→null normalization. `itemDetailsSchema` parsing.
- **Mocked-prisma (per `transfers.service.test.ts` convention):**
  `updateItemFields` updates the Item and inserts exactly one `ItemEdit` with the
  diff; writes **no** `ItemEdit` when nothing changed; both happen in one
  `$transaction`. `listUnits` ordering/shape.
- No React component tests (the project has no jsdom/testing-library and no new
  packages may be added).

## Out of scope

- Removing `deviceName`/`homeUnit` from the admin edit page (accepted duplication).
- Making the receipt-derived holder editable (deliberately rejected — it is the
  signed custody record).
- Converting `Item.homeUnit` into a foreign key to `Unit` (stays free text).
- Cleaning up the dead `.combo` CSS block.
- Backfilling history for edits made before this ships (there is no source for it).
- Any UI for browsing a single item's full edit history — only the latest edit
  shows on the card; the rest is visible on `/admin/audit`.
