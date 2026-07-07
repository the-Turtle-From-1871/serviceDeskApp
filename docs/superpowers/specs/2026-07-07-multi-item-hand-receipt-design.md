# Design: Multiple items per hand receipt

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Author:** Turto Labs + Claude

## Problem

Today a hand receipt (DA 2062) covers exactly **one** item. `Transfer` has a
single `itemId` and the PDF renders one row. Staff need to issue **multiple
items on a single hand receipt**:

- Multiple items of the **same make + model** are listed on **one row**, with all
  their serial numbers together in that row's description cell.
- **Different** items go on the **next row**.
- Each row carries two editable numbers:
  - **QTY AUTH** (DA 2062 column e / form field `QTY.N`) — the amount authorized.
  - **Column A** (the vertical right-hand guard column, drawn manually) — the
    number issued.
- The UI must let staff enter QTY AUTH and issued accurately per row.

## Decisions (locked with the user)

1. **Item selection:** multi-select checkboxes on the `/items` list → "Create
   receipt from N selected".
2. **Grouping key:** same **make + model** merges onto one row. Nothing else.
3. **Row numbers:** **both** QTY AUTH and Column A (issued) are editable per row,
   each defaulting to the count of serials in that row.
4. **Data model:** normalized — `TransferLine` (one per row, holds the two
   numbers) + `TransferItem` (one per physical serial).
5. **Row cap:** a receipt is capped at **18 rows** (the DA 2062 template's row
   capacity). Exceeding it shows a "too many item types — split into two
   receipts" message. Automatic continuation pages are out of scope for now.

## Current system (baseline)

- `Transfer { receiptNumber, itemId, itemSummary, sender*, receiver*,
  receiverSignature, status }` — one item per transfer.
- Entry point: `/items/[id]/transfer` — form is locked to one `itemId` via a
  hidden input (`ItemTransferForm.tsx`).
- `createTransferAction` → `createTransfer` → single `$transaction` that takes
  `nextval('receipt_number_seq')` and creates one `Transfer`.
- PDF: `buildHandReceiptPdf` fills row-1 fields (`aRow1`, `cRow1`, `UI.0`,
  `QTY.0`) and hand-draws `"1"` in Column A plus the recipient signature drawn
  **vertically across Column A**.
- Template (`da2062.base64.ts`) has form fields for ~18 rows: `aRow1..N`,
  `cRow1..N`, `UI.0..18`, `QTY.0..18`. **Column A is not a form field** — it is
  drawn manually.

## Data model

```prisma
model Transfer {
  id            String @id @default(cuid())
  receiptNumber String @unique
  itemSummary   String        // regenerated: "M4 Carbine (SN A1) +2 more"
  // sender*, receiver*, receiverSignature, status, createdBy* — unchanged
  lines         TransferLine[]
  // REMOVED: itemId, item relation
}

model TransferLine {
  id           String @id @default(cuid())
  transfer     Transfer @relation(fields: [transferId], references: [id], onDelete: Cascade)
  transferId   String
  lineNo       Int              // 1-based row order on the receipt
  make         String
  model        String
  unitOfIssue  String @default("EA")
  qtyAuth      Int              // -> QTY.N form field
  qtyIssued    Int              // -> Column A drawn text
  items        TransferItem[]
}

model TransferItem {
  id             String @id @default(cuid())
  line           TransferLine @relation(fields: [transferLineId], references: [id], onDelete: Cascade)
  transferLineId String
  item           Item @relation(fields: [itemId], references: [id])
  itemId         String
  serialNumber   String          // snapshot — stays truthful if Item is edited
}
```

`serialNumber` is snapshotted onto `TransferItem` so a signed receipt remains a
faithful record even if the underlying `Item` is later edited or retired.
`itemId` FK powers per-item history queries.

### Migration (data-preserving)

Production is live (Vercel + Supabase), so the migration must backfill:

1. Create `TransferLine` and `TransferItem` tables.
2. For each existing `Transfer`: create one `TransferLine`
   (`lineNo=1`, make/model from the joined `Item`, `unitOfIssue="EA"`,
   `qtyAuth=1`, `qtyIssued=1`) and one `TransferItem`
   (`itemId`, `serialNumber` from the `Item`).
3. Drop `Transfer.itemId`.

> **Deploy rule:** run `db:deploy` against Supabase **before** pushing code —
> the Vercel build does not migrate. Existing receipts must render identically
> after the backfill (verify one old receipt PDF post-migration).

## Selection flow (`/items`)

- Add a checkbox column; a small client component owns selection state.
- Only `ACTIVE` items are selectable (retired items cannot transfer).
- A sticky action bar shows **"Create receipt from N selected"** and navigates
  to `/receipts/new` with the selected item IDs.
- If the selection spans more than 18 distinct make+model groups, block with the
  split message before leaving the page.

## Receipt builder page (`/receipts/new`)

- Server-loads the selected items; rejects any that are missing/retired.
- Groups by make+model into lines, preserving selection order for `lineNo`.
- Per line: description (`make model`), all serials, and two editable number
  inputs — **Auth** and **Issued** — each defaulting to the serial count.
- One Sender / Recipient / Signature block for the whole receipt (reuse
  `PartyFields` + `SignaturePad`).
- Sender prefill: if **every** selected item shares an identical last receiver,
  prefill it; otherwise leave blank.

## Server action + validation

- New `receiptSchema` (Zod): `itemIds[]` (non-empty, ≤ enough for 18 groups),
  per-line `{ make, model, qtyAuth, qtyIssued }` as positive ints, `sender`,
  `receiver`, `receiverSignature` (existing rules).
- The **server re-groups the items by make+model authoritatively** — it never
  trusts client-side grouping — and matches each submitted `{qtyAuth, qtyIssued}`
  to its group by the make+model key.
- `createTransfer(multi)` in one `$transaction`:
  1. Load all items; reject if any missing or `RETIRED`.
  2. Reject if grouped line count > 18 (split message).
  3. `nextval('receipt_number_seq')` → one `receiptNumber`.
  4. Create `Transfer` + `TransferLine`s + `TransferItem`s.
  5. Regenerate `itemSummary` ("first (SN x) +N more").

## PDF rendering (`hand-receipt.ts`) — main rewrite

- `ReceiptData.item` → `ReceiptData.lines: { lineNo, make, model, serials[],
  unitOfIssue, qtyAuth, qtyIssued }[]`.
- For each line fill `aRow{lineNo}` (line number), `cRow{lineNo}`
  (`"{make} {model}\nSER NO: A1, A2, A3"`), `UI.{i}` (unit), `QTY.{i}`
  (**= qtyAuth**).
- **Column A (issued):** draw each line's `qtyIssued` at that row's Y position in
  the vertical guard column, replacing the single hardcoded `"1"`.
- **Signature:** move the recipient signature out of Column A (now needed for
  per-row issued numbers) into the form's designated signature block. The custody
  record page keeps the full signature.
- Custody record page: list all lines instead of one item.
- **Risks / fiddly bits:**
  - Row-Y calibration for Column A issued numbers — verify visually against a
    rendered PDF.
  - Description-cell overflow when one group has many serials — shrink-to-fit or
    truncate-with-count; decide in the plan.

## History, search, email

- `listReceiptsForItem(itemId)` and `getLastReceiver(itemId)` query through
  `TransferItem`.
- `searchReceiptsByNumber` keeps using the regenerated `itemSummary`.
- `sendReceiptEmails` receives the multi-item `itemSummary`.

## Testing

- **Unit:** group-by-make+model, `itemSummary` generation, `receiptSchema`
  validation, 18-row cap rejection.
- **Service:** `createTransfer` with several lines; receipt-number uniqueness;
  retired/missing-item rejection; migration backfill correctness (old
  single-item transfer → one line + one item).
- **PDF:** `buildHandReceiptPdf` with N lines → N rows with correct
  QTY AUTH and issued; single-line still matches the old layout.
- **E2E:** select multiple items → build receipt → download PDF.

## Out of scope

- Automatic continuation pages beyond 18 rows.
- Editing an existing receipt's line quantities after creation.
- Mixed unit-of-issue per row (assumed "EA" unless the item model dictates otherwise).
