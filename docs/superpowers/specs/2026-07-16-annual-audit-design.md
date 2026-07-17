# Annual Audit Feature — Design

**Date:** 2026-07-16
**Status:** Approved for planning

## Purpose

Let admins verify, on an annual cadence, that people still have possession of the
devices assigned to them. Each item carries an **audit status** shown as a colored
light on both the item detail page and the items list. An admin technician marks an
item as audited; the date and their signature are logged permanently.

## Requirements

- An audit status is visible on the item detail page and the items list view.
- Status shows as a light:
  - **Green** — audit-compliant (audited within the last calendar year).
  - **Yellow** — overdue (last audit older than 1 year).
  - **Gray/unlit** — never audited (a distinct third state).
- The status turns yellow exactly **1 calendar year** after the last audit.
- On the item page, an admin technician can mark the item as audited. The audit
  **date** and the technician's **signature** are logged there.
- A **full history** of audit events is retained (not just the latest).
- When an item is **overdue** (and only overdue — not never-audited), the item
  detail page shows a prominent amber banner near the top. Never-audited and
  compliant items show only the dot.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Record model | **Full history log** — new `ItemAudit` table; status derived from newest row. |
| Signature capture | **Pick a saved signature** — reuse the named-`Signature` infrastructure. |
| Never-audited items | **Distinct third state** (gray/unlit), separate from overdue. |
| Retired items | **No light** — neutral dash (—); mark-audited control hidden + rejected server-side. |
| Who sees the light | **All logged-in users** (matches the Service card). |
| Who can mark audited | **Admins only** (`requireAdmin`). |
| Audit period | **1 calendar year** from the last audit date. |
| Overdue banner | **Overdue only** — amber banner on the item detail page; never-audited stays a quiet dot. |

## Data model

New history table; one row per audit event. Mirrors the `ItemEdit` /
`ReturnTransaction` snapshot pattern so history survives deletion of the acting
account or the source signature.

```prisma
model ItemAudit {
  id             String   @id @default(cuid())
  item           Item     @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId         String
  // Nullable + SetNull with a denormalized name snapshot: history survives the
  // auditor's account being deleted (mirrors ItemEdit.editedBy / ReturnTransaction).
  auditedBy      User?    @relation("ItemAudits", fields: [auditedById], references: [id], onDelete: SetNull)
  auditedById    String?
  auditedByName  String   // acting admin's account name, snapshotted
  signerName     String   // name on the chosen signature (the technician credited)
  signatureImage String   // PNG data URL, snapshotted at audit time
  createdAt      DateTime @default(now()) // = the audit date
  @@index([itemId, createdAt])
}
```

Add to `Item`: `audits ItemAudit[]`. Add to `User`: `itemAudits ItemAudit[] @relation("ItemAudits")`.

No new columns on `Item`: the latest audit is the newest `ItemAudit` row, keeping a
single source of truth (consistent with the full-history decision).

`auditedByName` (who operated the system) is stored separately from `signerName`
(the name on the chosen signature). They can differ — an admin may hold named
signatures belonging to several technicians — so both are recorded, exactly as
`ReturnTransaction` keeps `processedByName` alongside its signature.

## Status logic — pure module

`src/modules/audit/audit.status.ts` (unit-tested, mirroring
`service-queue.status.ts`):

```ts
export type AuditState = "compliant" | "overdue" | "never";
export const AUDIT_PERIOD_YEARS = 1;

// null lastAuditedAt -> "never"; within 1 calendar year -> "compliant"; else "overdue".
export function auditState(lastAuditedAt: Date | null, now: Date): AuditState;
```

- `never` when `lastAuditedAt` is null.
- `compliant` when `now` is before `lastAuditedAt` + 1 calendar year (leap-year safe).
- `overdue` otherwise.

Retired items are **not** passed through this function; the display layer renders a
neutral dash for them.

Also a display helper mapping state → `{ label, className }`:
`compliant → "Compliant" / audit-dot--compliant`, `overdue → "Overdue"`,
`never → "Never audited"`.

## Service layer

`src/modules/audit/audit.service.ts`:

- `recordAudit({ itemId, auditedById, auditedByName, signerName, signatureImage })`
  — creates one `ItemAudit` row.
- `getAuditsForItem(itemId)` — all audits for an item, newest first (detail-page log).
- `getLatestAuditMap(itemIds?)` — `groupBy` on `ItemAudit` returning
  `Map<itemId, Date>` of the newest `createdAt` per item, for the list view.

## Server action

`src/app/admin/actions/audit.ts` → `markAuditedAction(formData)`:

1. `const user = await requireAdmin();`
2. Zod-parse `{ itemId, signatureId }`.
3. Load the item; **reject if `status === "RETIRED"`** (backend validation matching
   the hidden UI, following the DCSIM notify pattern).
4. `const sig = await getOwnedSignature(signatureId, user.id);` — reject if null
   (not owned / bogus id).
5. `recordAudit({ itemId, auditedById: user.id, auditedByName: user.name,
   signerName: sig.name, signatureImage: sig.image })`.
6. `revalidatePath('/i/${itemId}')` and `revalidatePath('/items')`.
7. Catch failures; return a generic error string to the UI, log detail server-side.

**Security:** the client posts only `signatureId`. The server re-reads the signer
name and image from the DB scoped to the acting admin via `getOwnedSignature`, so a
client cannot forge a signer name, inject an image, or use another admin's
signature. This matches the returns flow.

## UI — item detail page (`src/app/i/[itemId]/page.tsx`)

An **overdue banner** near the top of the page (after the title row), shown only
when the item is **overdue** — an amber `.alert-warning` callout, e.g. "This item
is overdue for its annual audit." Never-audited and compliant items show no banner.

A new **Audit card**, gated on `loggedIn` like the Service card:

- **Status row:** the audit light + label (Compliant / Overdue / Never audited), and
  the last-audited date + signer name (or "Never audited").
- **Admin + ACTIVE item only:** an `AuditControls` client component —
  - A `<select>` of the admin's saved signatures (from `listSignatures(user.id)`,
    passed in from the server component) + a "Mark as audited" button.
  - Posts only `signatureId` to `markAuditedAction`.
  - If the admin has no saved signatures, show a note linking to `/account` to
    create one (no draw-inline path — saved signatures only, per decision).
  - Retired items: the control is not rendered (and the action rejects them).
- **Audit log:** a list of past audits — signer name, date (`formatDateTimeHST`),
  and a signature thumbnail — newest first.

## UI — items list (`src/app/items/page.tsx` + `ItemSelectTable`)

- Extend `ItemRow` (`src/components/items-view.ts`) with `auditState: AuditState`
  and add an **"Audit"** entry to `ITEM_COLUMNS`. This makes the column sortable via
  the existing sort dropdown and hideable via the Columns menu for free.
- New `AuditLight` component renders a colored dot with a `title` / `aria-label`
  (e.g. "Audit: Overdue") so the signal is not color-only. Retired rows render a
  neutral dash (—) instead of a light.
- CSS classes in `globals.css`: `.audit-dot`, `.audit-dot--compliant` (green),
  `.audit-dot--overdue` (amber/yellow), `.audit-dot--never` (gray).
- `listItems` (`src/modules/items/items.service.ts`) calls `getLatestAuditMap` and
  the page computes each row's `auditState` (forcing the dash for retired items at
  render time, not in the pure function).

## Migration

This shell cannot run `prisma migrate dev` (Prisma 7 + non-interactive). Author the
migration via `prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script` into a new migration folder, then apply with
`prisma migrate deploy`. The change is a single `CREATE TABLE "ItemAudit"` plus its
`(itemId, createdAt)` index and foreign keys — no changes to existing columns.

## Testing

- **Unit** (`audit.status.test.ts`): `never` (null), `compliant`/`overdue`
  boundaries around the 1-year mark, and a leap-year case (audited 2024-02-29).
- **Integration** (vitest): `recordAudit` writes a row; `getLatestAuditMap` returns
  the newest date per item; `markAuditedAction` — happy path, unauthenticated /
  non-admin rejection, retired-item rejection, and unowned-`signatureId` rejection.
- **Visual proof:** verify the three light states + retired dash in a real browser.
  jsdom has no layout engine, so neither it nor `npm run build` is evidence for the
  CSS. (Note: parallel agents share one test DB — do not run the suite concurrently.)

## Out of scope (YAGNI)

- Bulk "mark audited" across many items at once.
- Configurable audit period (fixed at 1 year).
- Notifications / reminders for overdue audits.
- Auditing retired items.
