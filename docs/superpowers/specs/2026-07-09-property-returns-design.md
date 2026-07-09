# Design: Property Returns (partial & full)

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan
**Paradigm:** DA Form 2062 property accountability — active record linked to an
immutable ledger; historical data retained (digital "redline"), never overwritten.

## Problem

A service-desk tech needs to process equipment **returns** against a hand
receipt: a customer brings back some or all of their issued gear. The system
must compute new balances, preserve the old record ("redline"), log the
transaction immutably, alert the customer, and — when everything is returned —
lock the receipt and generate a clearance document.

## Reconciliation with the existing app (important)

The G6 functional spec is written for a "one OPEN hand receipt per customer with
a running held-quantity" paradigm. This app is **receipt-centric**: every hand
receipt is its own immutable `HR-######` record (`Transfer`), a customer can
hold several, items are tracked by **serial number** (`TransferItem`), there is
no "held quantity" field, and there is no email→receipt lookup. This design maps
the spec's intent onto the app's real structures.

## Decisions (locked with the user)

1. **Targeting:** returns are processed **per receipt**, initiated from the
   receipt page `/receipts/[receiptNumber]` — the page the QR code opens — so a
   tech can scan and process in one step. No email-based lookup.
2. **Granularity:** the tech **checks off the specific serial numbers** returned.
   Balance = count of un-returned serials. (Supports the spec's "list serials
   returned" email and the mandatory serial-verification checkbox.)
3. **Partial vs full is auto-detected:** if any serials remain held after the
   return → PARTIAL (receipt stays OPEN); if all remaining serials are checked →
   FULL (receipt → CLOSED, locked).
4. **Existing data:** all existing `COMPLETED` receipts migrate to `OPEN` — they
   become returnable (reflects gear still out).
5. **Who processes returns:** admin / service-desk only (`requireAdmin`).
6. **Customer notified:** the **receiver** party (the person gear was issued to);
   CC the G6 service-desk shared inbox.
7. **Ledger:** a new immutable `ReturnTransaction` table (create-only, like
   `ImportBatch`).

## Current system (baseline)

- `Transfer` (hand receipt): `receiptNumber @unique`, `itemSummary`, party fields
  (`senderEmail`/`receiverEmail` nullable, lowercased), `receiverSignature`,
  `status TransferStatus @default(COMPLETED)`, `createdAt`. No `updatedAt`
  (create-only in practice). `TransferStatus = COMPLETED | VOID` — `VOID` is
  defined but **never written** anywhere (free to repurpose).
- `TransferLine`: `lineNo, make, model, unitOfIssue, qtyAuth, qtyIssued`,
  `items TransferItem[]`.
- `TransferItem`: join line↔`Item`, snapshots `serialNumber`. **No return state.**
- `transfers.service.ts`: `createTransfer` (hardcodes `status:"COMPLETED"`),
  `getTransferByReceiptNumber` (include lines→items), `searchReceiptsByNumber`,
  `listReceiptsForItem`, `getLastReceiver`. **No transfer-mutation function
  exists.**
- PDF: `buildHandReceiptPdf(t: ReceiptData): Promise<Uint8Array>` in
  `src/modules/receipts/hand-receipt.ts`; page 1 = DA 2062 AcroForm, Column A
  renders per-row issued qty + a **vertical** (rotated 90°) recipient signature
  and date in the empty column, with black guard bars; page 2 = custody record
  (already renders a `Status` meta row). Regenerated on demand from
  `ReceiptData` in `src/app/receipts/[receiptNumber]/pdf/route.ts` (supports
  `?preview` → inline).
- Email: `EmailMessage { to, subject, text, html? }` — **no `cc`/`from` per
  message**; `getEmailSender()` → `ResendEmailSender` (POST api.resend.com) or
  `LogEmailSender`. `sendReceiptEmails` sends one message per non-DCSIM party
  with an email, best-effort (try/catch swallow).
- Auth: `requireUser`/`requireAdmin` → `SessionUser { id, role, name, email }`.
- Audit page `/admin/audit`: lists transfers + (new-ish) an `ImportBatch` "CSV
  imports" section.

## Data model changes

```prisma
enum TransferStatus {
  OPEN
  CLOSED
}
// Migration: rename/repurpose. All existing rows (COMPLETED) -> OPEN.
// Transfer.status default becomes OPEN. VOID value dropped (unused).

model TransferItem {
  // ...existing fields...
  returnedAt DateTime?   // null = still held; set once when returned (immutable)
  // (optional link) returnedByReturn ReturnTransaction? @relation(...)
}

model ReturnTransaction {
  id                String   @id @default(cuid())
  transfer          Transfer @relation("TransferReturns", fields: [transferId], references: [id], onDelete: Cascade)
  transferId        String
  receiptNumber     String                 // snapshot
  kind              ReturnKind             // PARTIAL | FULL
  processedByUser   User?    @relation("ReturnsProcessed", fields: [processedByUserId], references: [id])
  processedByUserId String?
  processedByName   String                 // snapshot of tech name
  processedByEmail  String                 // snapshot of tech email
  returned          Json                   // [{ serialNumber, make, model }]
  returnedCount     Int
  remainingCount    Int                    // held serials remaining after this event
  createdAt         DateTime @default(now())

  @@index([transferId])
}

enum ReturnKind {
  PARTIAL
  FULL
}
```
- `Transfer` gets `returns ReturnTransaction[] @relation("TransferReturns")`.
- `User` gets `returnsProcessed ReturnTransaction[] @relation("ReturnsProcessed")`.
- **Migration is additive** (new table, new nullable column, enum repurpose +
  data update). Must `db:deploy` to Supabase **before** pushing (standing rule).

## Modules & flow

### Pure planning — `src/modules/returns/plan.ts`
- `type HeldItem = { transferItemId: string; serialNumber: string; make: string; model: string; lineNo: number }`
- `type ReturnPlan = { kind: "PARTIAL" | "FULL"; returned: HeldItem[]; remaining: HeldItem[]; byLine: { lineNo: number; make: string; model: string; heldBefore: number; returnedNow: number; heldAfter: number }[] }`
- `planReturn(held: HeldItem[], serialNumbers: string[]): { plan?: ReturnPlan; error?: string }`
  - Validate every requested serial is in `held` (currently-held) — unknown or
    already-returned serial → `error` (nothing processed).
  - Reject empty selection → `error` (anti-blank at the domain layer too).
  - `kind = FULL` when `returned.length === held.length`, else `PARTIAL`.
  - Compute per-line before/after counts for the redline UI + email.
- Pure and unit-tested (no DB).

### Service — `src/modules/returns/returns.service.ts`
```
processReturn(input: {
  receiptNumber: string;
  serialNumbers: string[];
  processedBy: { id: string; name: string; email: string };
}): Promise<{ plan: ReturnPlan; receiptNumber: string } | { error: string }>
```
1. Load the receipt (`getTransferByReceiptNumber`) with lines→items. Not found →
   `error`. Status not `OPEN` → `error` ("already closed").
2. Build `held` from `TransferItem`s where `returnedAt == null`.
3. `planReturn(held, serialNumbers)`; on error return it (nothing written).
4. In one `prisma.$transaction`:
   - Re-assert inside the tx that the selected items are still un-returned
     (concurrency guard); if any already returned → abort with `error`.
   - `updateMany` set `returnedAt = now()` on the returned `TransferItem`s.
   - If `kind === "FULL"` → set `Transfer.status = "CLOSED"`.
   - `create` the `ReturnTransaction` (snapshots + counts).
5. Return `{ plan, receiptNumber }`. Email is sent by the action layer
   (best-effort, outside the tx).

### Server action — `src/app/actions/returns.ts` (`"use server"`)
- `processReturnAction(prev, formData)`: `requireAdmin()` first; parse checked
  serials + the mandatory verification checkbox from `formData` (reject if the
  checkbox is not set — server-side enforcement of the safeguard); call
  `processReturn`; on success `revalidatePath("/receipts/[receiptNumber]")` +
  `revalidatePath("/admin/audit")` and `sendReturnEmail(...)`; generic error +
  `console.error` on exception.

### Email — extend the email layer
- `EmailMessage` gains `cc?: string | string[]`; `ResendEmailSender.send`
  forwards `cc` in the POST body (Resend supports it). `LogEmailSender` logs it.
- New `src/modules/returns/send-return-email.ts`: `sendReturnEmail(args)` builds
  the partial or full message per `kind`, `to = receiver email` (skip if the
  receiver is DCSIM / has no email), `cc = process.env.G6_SERVICE_DESK_EMAIL`
  (omit cc if unset). Best-effort try/catch, like `sendReceiptEmails`.

**Partial email**
- Subject: `UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: HR-######]`
- Body: confirmation that the desk processed a partial return; list nomenclature
  + serial numbers + qty returned today; a "New Remaining Balance" section per
  line in redline style (`Old: 5 -> New Remaining: 3`, struck old value in the
  HTML); AR 735-5 liability statement for the remaining items; tech name/email +
  timestamp (HST).

**Full email**
- Subject: `CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: HR-######]`
- Body: confirmation all equipment returned + verified; list all items turned in;
  a bold **STATUS: CLEARED / CLOSED** banner; explicit zero-balance /
  no-longer-liable statement; a link to the closed-out PDF (which carries the
  VOID/CLEARED overlay); advice to save as the digital clearance record for
  out-processing/PCS/ETS; final clearance timestamp + tech name/email.

## UI

### Receipt page `src/app/receipts/[receiptNumber]/page.tsx`
- Fetch the receipt (already does) plus its returns. Render per-line balance:
  once any return exists, show the original held count struck-through/muted and
  the current held count bold (redline). Serial list marks returned serials.
- **Admin + status OPEN:** show a **"Process return"** button → `/return`.
- **Status CLOSED:** prominent **VOID / CLEARED** banner, muted/struck signature
  treatment, no action buttons. (Public view — no admin needed to see status.)

### Return page `src/app/receipts/[receiptNumber]/return/page.tsx` (admin)
- `requireAdmin()` in the page; 404/redirect if the receipt is not OPEN.
- Client form (`useActionState`): per-line list of currently-held serials with
  checkboxes; a "return all remaining" shortcut (drives the FULL path).
  **Safeguards:** submit disabled until (a) ≥1 serial checked (anti-blank) AND
  (b) the mandatory checkbox *"I have physically verified that the serial number
  on the device matches the screen"* is ticked. On success: redline summary of
  what was returned + remaining, whether the receipt is now CLOSED, and an
  email-sent note; link back to the receipt.

### Audit page `src/app/admin/audit/page.tsx`
- Add a **"Property returns"** section: `prisma.returnTransaction.findMany`
  (desc, take 50, include tech name) — date (HST), tech, receiptNumber, kind,
  returned serials, remaining count.

## PDF `src/modules/returns` overlay in `hand-receipt.ts`
- `ReceiptData.status` already threads through (`OPEN`/`CLOSED`). When `CLOSED`:
  - Draw a diagonal, semi-transparent red **"VOID / CLEARED"** watermark across
    page 1 (rotated `drawText`, low-opacity `rgb`).
  - Draw a strikethrough line over the vertical Column-A signature block and
    render its date/label in a muted red. (Uses already-imported `rgb`/`degrees`;
    signature geometry constants already exist near lines 114-158.)
- Partial returns do not alter the PDF (the redline lives on the web + email);
  only a full return (CLOSED) produces the VOID/CLEARED document.

## UI safeguards & operational rules (enforced)

- **Anti-blank:** submit blocked client-side until ≥1 serial checked; server also
  rejects an empty selection.
- **Serial checkpoint:** mandatory verification checkbox unlocks submit
  client-side AND is re-validated server-side in the action.
- **Immutable history:** `ReturnTransaction` and `TransferItem.returnedAt` are
  write-once; no undo/edit path. A mistake is corrected by a new, secondary
  return transaction. Over-return is impossible (only currently-held serials are
  selectable/accepted).
- **Concurrency:** the service re-asserts un-returned status inside the tx.
- **Admin-only** throughout (`requireAdmin` + the action guard).
- **Locked when CLOSED:** the return page/action reject a non-OPEN receipt; the
  receipt page hides all actions.

## Error handling

- Not found / already CLOSED / unknown or already-returned serial / empty
  selection / missing verification checkbox → returned as an `error` string;
  nothing written.
- Unexpected exceptions in the action → generic client message, `console.error`
  server-side.
- Email failures are best-effort and never roll back the committed return.

## Testing

- **Unit `plan.ts`:** partial subset → PARTIAL with correct before/after per
  line; all held → FULL; unknown serial → error; already-returned serial →
  error; empty selection → error; multi-line receipts; ordering/counts.
- **Service `returns.service.ts` (real test DB):** OPEN receipt partial return
  sets `returnedAt` on exactly the chosen items, writes a PARTIAL
  `ReturnTransaction`, leaves status OPEN; full return closes the receipt + FULL
  record; second return on a CLOSED receipt errors and writes nothing;
  concurrency guard.
- **Email:** partial vs full subject/body shape; `to`/`cc` targeting; DCSIM/no
  email → skipped gracefully; `cc` omitted when env unset.
- **Action:** admin guard; missing verification checkbox rejected; empty
  selection rejected.
- **PDF:** CLOSED receipt renders the watermark/strikethrough path without
  throwing (smoke).

## Out of scope

- Undo/reversal of a committed return (corrections are new transactions).
- Email-based / multi-receipt holder lookup.
- Returning items across receipts in one action (one receipt per return).
- Re-opening a CLOSED receipt.
- Partial-return watermark on the PDF (web + email carry the partial redline).
```
