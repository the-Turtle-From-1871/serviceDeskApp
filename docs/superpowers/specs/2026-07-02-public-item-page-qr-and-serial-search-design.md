# Public Item Page + Item QR + Search + Sequential Receipt #s — Design

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
**Builds on:** the shipped kiosk pivot + item-list-transfer follow-up.

## Summary

1. **Public item page** `/i/[itemId]` (no login) — item details, its QR code
   on-screen, and its hand-receipt history with PDF downloads.
2. **Item QR code** (restored, both forms) — an admin-only printable QR label PDF
   *and* the QR shown on the public item page; both encode the item page URL.
3. **Public search with a type dropdown** on `/` — choose **Serial number** or
   **Hand receipt number**:
   - Serial number → item lookup (partial/contains); single match redirects to
     that item's page, multiple matches show a list, none shows "not found".
   - Hand receipt number → redirects straight to that receipt's view page
     (`/receipts/[number]`); none shows "not found".
4. **Sequential receipt numbers** — `HR-000001`, `HR-000002`, … assigned in
   creation order via a Postgres sequence (replaces the random hex id).

## Decisions (from brainstorming)

- Public item page shows **item + full receipt history** (each downloadable).
- QR: **both** admin printable label PDF + QR on the public item page.
- Search: a **dropdown selects the mode** (serial vs receipt number). Serial =
  partial/contains → item; receipt number → the receipt directly.
- Receipt numbers are **sequential** (`HR-` + zero-padded sequence).
- **Enumerability accepted:** the receipt view/PDF stay fully public even though
  sequential numbers make them guessable. (Explicit product decision.)
- PII rule unchanged: rank/name/unit inline; email/contact/signature only in PDF.

## Architecture

### A. Public item page — `src/app/i/[itemId]/page.tsx` (public)

Server component, no `requireUser`. Loads the item via `getItem(id)` (404 via
`notFound()` if missing) and its receipts via `listReceiptsForItem(id)`. Renders:
- Header: brand + a "Search" link to `/`.
- Item block: make, model, serial, home unit, status badge.
- QR block: the item's QR image (`itemQrDataUrl(itemId)`), captioned "Scan to
  view this item."
- Receipt history: newest-first; each row shows the receipt number (link →
  `/receipts/[rn]`), `From → To` labels (`DCSIM · name`, else `RANK Name` with
  unit in parens — same helper style as the receipt page), the date (HST), and a
  **Download PDF** button (→ `/receipts/[rn]/pdf`). Empty state: "No hand receipts
  recorded for this item yet."

`src/proxy.ts`: add `i/` to the public matcher (alongside `login`, `register`,
`receipts/`).

### B. Item QR code (restored)

- **QR helpers** (`src/modules/items/qr.ts`): re-add `itemUrl(itemId, baseUrl?)`
  → `<base>/i/<itemId>` and `itemQrDataUrl(itemId, baseUrl?)`. Keep the existing
  `receiptUrl`/`receiptQrDataUrl`/`defaultBaseUrl`.
- **Label PDF builder** (`src/modules/receipts/qr-pdf.ts`, restored):
  `buildItemQrPdf(...)` → a printable PDF with the QR image and the item's
  make/model/serial/home-unit. Recover the prior implementation from git history;
  adapt to the reduced Item fields (no `assetTag`; `homeUnit`).
- **Admin QR page** (`src/app/admin/items/[itemId]/qr/page.tsx`, restored, admin
  layout): shows the QR on-screen + a "Print label (PDF)" link.
- **Admin QR PDF route** (`src/app/admin/items/[itemId]/qr/pdf/route.ts`,
  restored): `requireAdmin()`; load item (404 if missing); build QR data URL +
  `buildItemQrPdf`; stream `application/pdf` attachment.
- **Entry point:** a **"QR"** link per row on `/items` for admins (next to
  Edit/Retire) → `/admin/items/[id]/qr`.

### C. Public search with a mode dropdown — `/`

- **Service:** add `searchItemsBySerial(q)` (items where `serialNumber contains q`,
  case-insensitive, newest first; blank → `[]`) in `items.service.ts`. Receipt
  lookup reuses the existing `getTransferByReceiptNumber(rn)`.
- **Action** (`src/app/actions/search.ts`, new): `searchAction(_prev, formData)`
  reads `mode` (`"serial"` | `"receipt"`) and `query`:
  - blank query → `{ error: "Enter a search term." }`.
  - `mode="receipt"`: `getTransferByReceiptNumber(query)`; if found →
    `redirect("/receipts/" + t.receiptNumber)`; else `{ error: "No hand receipt
    found with that number." }`.
  - `mode="serial"`: `searchItemsBySerial(query)`; **exactly one** →
    `redirect("/i/" + items[0].id)`; **multiple** → `{ results }` (item cards);
    **none** → `{ error: "No items found with that serial number." }`.
  - (`redirect()` throws Next's redirect signal — let it propagate; only catch
    validation/empty cases into `{ error }`.)
- **Component** (`src/components/HomeSearch.tsx`, new, replaces `ReceiptSearch`):
  a `<select name="mode">` (Serial number / Hand receipt number) + a text input +
  Search button, via `useActionState(searchAction)`. On a `{ results }` response
  (multi serial match) render item cards linking to `/i/[id]`; on `{ error }`
  show the message. The redirect cases navigate away automatically.
- **Home page** (`src/app/page.tsx`): swap `ReceiptSearch` → `HomeSearch`; copy →
  "Find an item or hand receipt." Keep the existing auth-aware header.
- **Remove** the old public receipt search: delete `src/components/ReceiptSearch.tsx`
  and `src/app/actions/receipts.ts`; remove `searchReceipts` from the transfers
  service **if it has no other callers** (grep first).

### D. Sequential receipt numbers — `HR-000001`…

- **Migration** (new, additive & prod-safe — no data loss): `CREATE SEQUENCE
  IF NOT EXISTS "receipt_number_seq" START 1;`. Existing receipts keep their
  current `HR-<hex>` values (mixed formats coexist; search matches exact
  `receiptNumber` regardless).
- **Generation** (`transfers.service.ts` `createTransfer`): inside the existing
  transaction, `const rows = await tx.$queryRaw<{ n: bigint }[]>\`SELECT
  nextval('receipt_number_seq') AS n\`;` then `receiptNumber = "HR-" +
  String(rows[0].n).padStart(6, "0")`. `nextval` is atomic and unique across
  concurrent transactions, so the P2002 retry loop and the random
  `generateReceiptNumber()` helper are removed (delete `receipt-number.ts` + its
  test; drop `RECEIPT_COLLISION` from `TransferError` and its mapping in the
  transfer action). Keep `receiptNumber @unique`.
- Format note: `padStart(6)` yields `HR-000001`; beyond 999,999 the string simply
  grows — still unique and ordered.

### E. Data model

One additive migration (the sequence above). No table/column changes. New/restored
functions: `itemUrl`, `itemQrDataUrl`, `buildItemQrPdf`, `listReceiptsForItem`,
`searchItemsBySerial`. Removed: `generateReceiptNumber`, `searchReceipts` (if
unused), `searchReceiptsAction`, `ReceiptSearch`, `RECEIPT_COLLISION`.

## Error handling

- `/i/[itemId]`: unknown item → `notFound()`.
- Admin QR PDF route: unknown item → 404; non-admin → route/layout guard.
- `searchAction`: blank → friendly error; receipt/serial not found → friendly
  "not found"; redirects on single/receipt matches.
- QR generation failure on the item page degrades gracefully (skip the image; page
  still renders).

## Testing

- **Unit:** `itemUrl` → `<base>/i/<id>`; `searchItemsBySerial` matches serial
  contains + case-insensitive and returns `[]` for blank; `buildItemQrPdf` returns
  `%PDF-` bytes; `createTransfer` produces sequential `HR-<zero-padded>` numbers
  (assert format `^HR-\d{6,}$` and monotonic increase across two calls against a
  test DB or a mocked `nextval`).
- **Service/action:** `searchAction` — blank error; serial multi → results;
  (redirect cases: assert the redirect target or that `redirect` was invoked);
  `listReceiptsForItem` newest-first.
- **Access:** `/i/[itemId]` and `/` public; admin QR route admin-only.
- Update/remove tests tied to the deleted receipt search and
  `generateReceiptNumber`.

## Deployment / risks

- **Needs a migration** (`CREATE SEQUENCE`) applied to prod before the new code
  deploys — additive and safe (no data loss), unlike the pivot's destructive one.
- **Enumerability is an accepted product decision:** sequential public receipts
  can be scraped by guessing numbers; the receipt PDF's email/contact/signature
  are therefore effectively public. Documented here so it's a conscious choice.
- `buildItemQrPdf` recovered from git — verify it compiles against current pdf-lib
  and the reduced Item shape before wiring in.
