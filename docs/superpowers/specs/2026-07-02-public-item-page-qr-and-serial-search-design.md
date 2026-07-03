# Public Item Page + Item QR + Serial Search — Design

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
**Builds on:** the shipped kiosk pivot + item-list-transfer follow-up.

## Summary

Three connected changes. The item QR code and the public search both converge on
a new **public item page**:

1. **Public item page** `/i/[itemId]` (no login) — item details, its QR code
   on-screen, and its hand-receipt history with PDF downloads.
2. **Item QR code** (restored, both forms) — an admin-only printable QR label PDF
   *and* the QR shown on the public item page; both encode the item page URL.
3. **Public search** `/` — becomes an **item search by serial number** (partial /
   contains match) returning items that link to their item page; receipt-number
   search is removed from the public page.

## Decisions (from brainstorming)

- Public item page shows **item + full receipt history** (each downloadable).
- QR generation: **both** — admin printable label PDF + QR on the public item page.
- Public search: **serial-number only, partial (contains), case-insensitive**,
  returns a list of items.
- Same PII rule as the receipt page: rank/name/unit shown inline; email, contact,
  and signature only in the downloaded PDF.

## Architecture

### A. Public item page — `src/app/i/[itemId]/page.tsx` (public)

Server component, no `requireUser`. Loads the item via `getItem(id)` (404 via
`notFound()` if missing) and its receipts via `listReceiptsForItem(id)`. Renders:
- Header: brand + a "Search" link to `/`.
- Item block: make, model, serial, home unit, status badge.
- QR block: the item's QR code image (`itemQrDataUrl(itemId)`), captioned "Scan
  to view this item."
- Receipt history: newest-first list; each row shows the receipt number (link →
  `/receipts/[rn]`), `From → To` labels (DCSIM `DCSIM · name`, else `RANK Name`
  with unit in parens — same helper style as the receipt page), the date (HST),
  and a **Download PDF** button (→ `/receipts/[rn]/pdf`). Empty state: "No hand
  receipts recorded for this item yet."

`src/proxy.ts`: add `i/` to the public matcher negative-lookahead (alongside
`login`, `register`, `receipts/`).

### B. Item QR code (restored)

- **QR helpers** (`src/modules/items/qr.ts`): re-add `itemUrl(itemId, baseUrl?)`
  → `<base>/i/<itemId>` and `itemQrDataUrl(itemId, baseUrl?)`. Keep the existing
  `receiptUrl`/`receiptQrDataUrl`/`defaultBaseUrl`.
- **Label PDF builder** (`src/modules/receipts/qr-pdf.ts`, restored):
  `buildItemQrPdf(item, qrPngDataUrl)` → a printable PDF (letter or label-sized)
  with the QR image and the item's make/model/serial/home-unit text. (Recover the
  prior implementation from git history and adapt it to the reduced Item fields —
  no `assetTag`; `homeLocation`→`homeUnit`.)
- **Admin QR page** (`src/app/admin/items/[itemId]/qr/page.tsx`, restored, admin
  layout): shows the QR on-screen and a "Print label (PDF)" link to the route
  below.
- **Admin QR PDF route** (`src/app/admin/items/[itemId]/qr/pdf/route.ts`,
  restored): `requireAdmin()`; loads the item; builds the QR data URL +
  `buildItemQrPdf`; streams `application/pdf` as an attachment.
- **Entry point:** add a **"QR"** link per row on `/items` for admins (next to
  Edit/Retire) → `/admin/items/[id]/qr`.

### C. Public serial search — `/`

- **Service** (`src/modules/items/items.service.ts`): add
  `searchItemsBySerial(q: string)` → items where `serialNumber contains q`
  (case-insensitive), newest first; empty/whitespace query → `[]`.
- **Action** (`src/app/actions/items-search.ts`, new): `searchItemsAction(_prev,
  formData)` reads `query`, returns `{ error }` when blank, else `{ results }`
  where each result is `{ id, make, model, serialNumber, status }`.
- **Component** (`src/components/ItemSearch.tsx`, new, replaces `ReceiptSearch` on
  the home page): serial input + Search button; renders a list of matching items
  (make/model/serial + status), each linking to `/i/[id]`; "No items found" on
  empty results.
- **Home page** (`src/app/page.tsx`): swap `ReceiptSearch` → `ItemSearch`; update
  copy to "Find an item" / "Search by item serial number." Keep the existing
  auth-aware header (logged-in: Items/Admin/Sign out; else Staff sign in).
- **Remove** the public receipt search: delete `src/components/ReceiptSearch.tsx`
  and `src/app/actions/receipts.ts` (`searchReceiptsAction`), and the
  `searchReceipts` service function if it has no other callers. The receipt view
  (`/receipts/[rn]`) and PDF routes stay — they're reached via QR/email/item page.

### D. Data model

No schema changes. New/restored functions: `itemUrl`, `itemQrDataUrl`,
`buildItemQrPdf`, `listReceiptsForItem`, `searchItemsBySerial`.

## Error handling

- `/i/[itemId]`: unknown item → `notFound()` (404).
- Admin QR PDF route: unknown item → 404; non-admin → the admin layout / route
  guard redirects (`requireAdmin`).
- `searchItemsAction`: blank query → friendly error; zero matches → empty list
  message (not an error).
- QR generation failures on the item page degrade gracefully (skip the QR image;
  the page still renders) — mirror the receipt PDF's optional-QR pattern.

## Testing

- **Unit:** `itemUrl` builds `<base>/i/<id>`; `searchItemsBySerial` matches by
  serial contains + case-insensitive and returns `[]` for blank; `buildItemQrPdf`
  returns non-empty `%PDF-` bytes for a representative item.
- **Service/action:** `searchItemsAction` maps items to the result shape and
  errors on blank; `listReceiptsForItem` returns an item's transfers newest-first.
- **Access:** `/i/[itemId]` and `/` are public (no auth); the admin QR route is
  admin-only.
- Update/remove tests tied to the deleted receipt search (`searchReceipts` /
  `ReceiptSearch`).

## Open risks / notes

- Reintroducing `/i/[itemId]` as public means item metadata (make/model/serial)
  and the receipt history labels are publicly visible by item id — consistent with
  the existing "publicly searchable receipts" decision; no new PII beyond what the
  receipt page already exposes.
- `buildItemQrPdf` is recovered from git history; verify it compiles against the
  current pdf-lib version and the reduced Item shape before wiring it in.
