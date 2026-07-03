# Public Item Page + Item QR + Search + Sequential Receipt #s — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public item page (`/i/[itemId]`) with item QR codes (admin label PDF + on-page), a search-mode dropdown (serial → item, receipt # → receipt), and sequential `HR-000001` receipt numbers.

**Architecture:** Restore the item QR helpers/label builder and a public item page reachable by QR + serial search; add a mode dropdown to the public search; switch receipt-number generation from random hex to a Postgres sequence.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts`, Server Actions, Route Handlers), Prisma 7 + PostgreSQL, pdf-lib, qrcode, Zod v4, Vitest.

## Global Constraints

- **Next.js 16 is non-standard.** Mirror repo patterns: route/page `params` & `searchParams` are `Promise<…>` and awaited; server actions `"use server"` return `{ error }`/`{ results }` shapes for `useActionState` (or call `redirect()`); middleware is `src/proxy.ts`. Route handlers do NOT run layouts — they must guard auth themselves.
- **Receipt number format:** `HR-` + `String(nextval).padStart(6, "0")` → `HR-000001`. Sequential via Postgres sequence `receipt_number_seq`. Existing `HR-<hex>` receipts keep their values.
- **Public routes:** `/`, `/login`, `/register`, `/receipts/*`, and now `/i/*`. Admin QR pages/route stay admin-only.
- **Search:** dropdown `mode` = `serial` | `receipt`. Serial = `serialNumber contains` (case-insensitive): 1 match → redirect to `/i/[id]`, many → results list, none → error. Receipt = exact `getTransferByReceiptNumber` → redirect to `/receipts/[number]`, none → error.
- **PII rule:** item page + search show rank/name/unit only; email/contact/signature only in the PDF.
- **Enumerability accepted:** receipt view/PDF stay public.
- **Commit** after each task's tests pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`. Docker Postgres up on `localhost:5435`.

---

## File Structure

**Created**
- `prisma/migrations/20260703_receipt_number_seq/migration.sql` — `CREATE SEQUENCE`
- `src/modules/receipts/qr-pdf.ts` — `buildItemQrPdf` (restored)
- `src/app/i/[itemId]/page.tsx` — public item page
- `src/app/admin/items/[itemId]/qr/page.tsx` — admin on-screen QR (restored)
- `src/app/admin/items/[itemId]/qr/pdf/route.ts` — admin QR label PDF (restored)
- `src/app/actions/search.ts` — `searchAction`
- `src/components/HomeSearch.tsx` — home search with mode dropdown
- Tests alongside modules

**Modified**
- `src/modules/transfers/transfers.service.ts` — sequence-based `createTransfer`; add `listReceiptsForItem`; remove `searchReceipts` (Task 4)
- `src/modules/transfers/transfers.service.test.ts` — update createTransfer assertion; drop searchReceipts test
- `src/modules/transfers/transfers.errors.ts` — remove `RECEIPT_COLLISION`
- `src/app/actions/transfers.ts` — remove `RECEIPT_COLLISION` mapping
- `src/modules/items/qr.ts` — add `itemUrl`/`itemQrDataUrl`
- `src/modules/items/items.service.ts` — add `searchItemsBySerial`
- `src/app/items/page.tsx` — admin "QR" row action
- `src/app/page.tsx` — swap `ReceiptSearch` → `HomeSearch`
- `src/proxy.ts` — add `i/` to public matcher

**Deleted**
- `src/modules/transfers/receipt-number.ts` + `receipt-number.test.ts`
- `src/components/ReceiptSearch.tsx`, `src/app/actions/receipts.ts`

---

## Task 1: Sequential receipt numbers

**Files:**
- Create: `prisma/migrations/20260703_receipt_number_seq/migration.sql`
- Modify: `src/modules/transfers/transfers.service.ts`, `transfers.errors.ts`, `src/app/actions/transfers.ts`, `src/modules/transfers/transfers.service.test.ts`
- Delete: `src/modules/transfers/receipt-number.ts`, `src/modules/transfers/receipt-number.test.ts`

**Interfaces:**
- Produces: `createTransfer` now emits `receiptNumber = "HR-" + String(nextval('receipt_number_seq')).padStart(6,"0")`; `TransferError` codes reduce to `"ITEM_NOT_FOUND" | "ITEM_RETIRED"`.

- [ ] **Step 1: Create the migration**

Create `prisma/migrations/20260703_receipt_number_seq/migration.sql` (timestamp sorts after `20260702_kiosk_pivot`):
```sql
-- Sequential hand-receipt numbers (HR-000001, ...). Additive & prod-safe.
CREATE SEQUENCE IF NOT EXISTS "receipt_number_seq" START 1;
```

- [ ] **Step 2: Apply the migration + verify**

Run:
```bash
npx prisma migrate deploy
npx prisma migrate status
```
Expected: the new migration applies; status reports up to date. (`migrate deploy` applies the manually-authored migration; there is no schema.prisma change, so nothing else is generated.)

- [ ] **Step 3: Trim the error type**

`src/modules/transfers/transfers.errors.ts` — set the union to:
```ts
export class TransferError extends Error {
  constructor(public code: "ITEM_NOT_FOUND" | "ITEM_RETIRED") {
    super(code);
    this.name = "TransferError";
  }
}
```

- [ ] **Step 4: Delete the random generator + its test**

```bash
git rm src/modules/transfers/receipt-number.ts src/modules/transfers/receipt-number.test.ts
```

- [ ] **Step 5: Update the createTransfer test for sequential numbers**

In `src/modules/transfers/transfers.service.test.ts`: the mocked `tx` needs a `$queryRaw` returning the sequence value. Add to the `tx` mock object `$queryRaw: vi.fn(async () => [{ n: 42n }])`, and change the createTransfer assertion from the old `HR-[0-9A-F]{8}` regex to:
```ts
    expect(call.receiptNumber).toBe("HR-000042");
```
(Remove any assertion/expectation referencing `generateReceiptNumber` or `RECEIPT_COLLISION`.)

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- transfers.service`
Expected: FAIL — createTransfer still uses `generateReceiptNumber` (receiptNumber won't equal `HR-000042`).

- [ ] **Step 7: Rewrite createTransfer to use the sequence**

In `src/modules/transfers/transfers.service.ts`: remove `import { Prisma } from "@prisma/client";` (keep `import type { Item, Transfer } from "@prisma/client";`) and `import { generateReceiptNumber } from "./receipt-number";`. Replace `createTransfer` with:
```ts
export async function createTransfer(
  input: TransferInput & { createdByUserId?: string }
): Promise<Transfer> {
  const { itemId, sender, receiver, receiverSignature, createdByUserId } = input;
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("ITEM_NOT_FOUND");
    if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");
    // Sequential, gap-tolerant receipt number. nextval is atomic across
    // concurrent transactions, so no collision handling is needed. pg may
    // return the value as bigint or string; String() handles both.
    const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('receipt_number_seq') AS n`;
    const receiptNumber = `HR-${String(rows[0].n).padStart(6, "0")}`;
    return tx.transfer.create({
      data: {
        receiptNumber,
        itemId,
        itemSummary: itemSummary(item),
        senderIsDcsim: sender.isDcsim,
        senderName: sender.name,
        senderRank: sender.rank ?? null,
        senderUnit: sender.unit ?? null,
        senderContact: sender.contact ?? null,
        senderEmail: sender.email ?? null,
        receiverIsDcsim: receiver.isDcsim,
        receiverName: receiver.name,
        receiverRank: receiver.rank ?? null,
        receiverUnit: receiver.unit ?? null,
        receiverContact: receiver.contact ?? null,
        receiverEmail: receiver.email ?? null,
        receiverSignature,
        createdByUserId: createdByUserId ?? null,
        status: "COMPLETED",
      },
    });
  });
}
```

- [ ] **Step 8: Remove the RECEIPT_COLLISION mapping in the action**

In `src/app/actions/transfers.ts`, delete the `RECEIPT_COLLISION: "…"` line from the `TransferError` message map (leave `ITEM_NOT_FOUND` and `ITEM_RETIRED`).

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- transfers.service` then `npm test`
Expected: PASS (createTransfer emits `HR-000042`; full suite green minus the deleted receipt-number test).

- [ ] **Step 10: Commit**

```bash
git add prisma/migrations src/modules/transfers src/app/actions/transfers.ts
git commit -m "feat(receipts): sequential HR-000001 receipt numbers via Postgres sequence"
```

---

## Task 2: Item QR helpers + label PDF (restored)

**Files:**
- Modify: `src/modules/items/qr.ts`, `src/modules/items/qr.test.ts`
- Create: `src/modules/receipts/qr-pdf.ts`, `src/modules/receipts/qr-pdf.test.ts`

**Interfaces:**
- Produces: `itemUrl(itemId, baseUrl?) → "<base>/i/<itemId>"`, `itemQrDataUrl(itemId, baseUrl?) → Promise<string>`; `buildItemQrPdf(item: {id,make,model,serialNumber,homeUnit}) → Promise<Uint8Array>`.

- [ ] **Step 1: Add a failing itemUrl test**

Add to `src/modules/items/qr.test.ts`:
```ts
import { itemUrl } from "./qr";
it("builds an absolute item URL", () => {
  expect(itemUrl("itm1", "https://app.example")).toBe("https://app.example/i/itm1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- qr`
Expected: FAIL — `itemUrl` not exported.

- [ ] **Step 3: Add the QR helpers**

In `src/modules/items/qr.ts`, add the QRCode import at top and the two helpers (keep `defaultBaseUrl`/`receiptUrl`):
```ts
import QRCode from "qrcode";
// … existing defaultBaseUrl, receiptUrl …
export function itemUrl(itemId: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}
export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(itemUrl(itemId, baseUrl), { margin: 1, width: 320 });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- qr`
Expected: PASS.

- [ ] **Step 5: Write a failing qr-pdf test**

Create `src/modules/receipts/qr-pdf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildItemQrPdf } from "./qr-pdf";

describe("buildItemQrPdf", () => {
  it("produces a non-empty PDF for an item", async () => {
    const bytes = await buildItemQrPdf({ id: "itm1", make: "Dell", model: "Latitude", serialNumber: "SN123", homeUnit: "A Co" });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- qr-pdf`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement qr-pdf.ts (restored, reduced Item)**

Create `src/modules/receipts/qr-pdf.ts`:
```ts
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";

type QrItem = { id: string; make: string; model: string; serialNumber: string; homeUnit: string | null };

// Single-page, print-friendly label: item identity, a large QR code, and its URL.
export async function buildItemQrPdf(item: QrItem): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.5);

  const dataUrl = await itemQrDataUrl(item.id);
  const png = await pdf.embedPng(Buffer.from(dataUrl.split(",")[1], "base64"));

  let y = 740;
  page.drawText("HAND RECEIPT — ITEM", { x: 56, y, size: 12, font: bold, color: muted });
  y -= 34;
  page.drawText(`${item.make} ${item.model}`, { x: 56, y, size: 24, font: bold, color: ink });
  y -= 40;
  const rows: [string, string][] = [
    ["Serial number", item.serialNumber],
    ["Home unit", item.homeUnit ?? "—"],
  ];
  for (const [k, v] of rows) {
    page.drawText(k, { x: 56, y, size: 11, font: bold, color: muted });
    page.drawText(v, { x: 200, y, size: 12, font, color: ink });
    y -= 22;
  }
  const qrSize = 300, qrX = (612 - qrSize) / 2, qrY = 190;
  page.drawImage(png, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  const url = itemUrl(item.id);
  const urlWidth = font.widthOfTextAtSize(url, 10);
  page.drawText(url, { x: (612 - urlWidth) / 2, y: qrY - 26, size: 10, font, color: muted });
  const scan = "Scan to view item details and hand receipt history";
  const scanWidth = font.widthOfTextAtSize(scan, 11);
  page.drawText(scan, { x: (612 - scanWidth) / 2, y: qrY - 48, size: 11, font, color: ink });
  return pdf.save();
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- qr qr-pdf`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/items/qr.ts src/modules/items/qr.test.ts src/modules/receipts/qr-pdf.ts src/modules/receipts/qr-pdf.test.ts
git commit -m "feat(items): restore item QR helpers + printable label PDF"
```

---

## Task 3: Public item page + admin QR pages + wiring

**Files:**
- Create: `src/app/i/[itemId]/page.tsx`, `src/app/admin/items/[itemId]/qr/page.tsx`, `src/app/admin/items/[itemId]/qr/pdf/route.ts`
- Modify: `src/modules/transfers/transfers.service.ts` (add `listReceiptsForItem`), `src/app/items/page.tsx` (admin QR link), `src/proxy.ts`

**Interfaces:**
- Consumes: `getItem(id)`; `itemUrl`/`itemQrDataUrl` (Task 2); `buildItemQrPdf` (Task 2); `requireAdmin`/`AuthError`; `StatusBadge`; `formatDateTimeHST`.
- Produces: `listReceiptsForItem(itemId): Promise<Transfer[]>` (item's transfers, newest first).

- [ ] **Step 1: Add listReceiptsForItem to the transfers service**

In `src/modules/transfers/transfers.service.ts`, add:
```ts
export function listReceiptsForItem(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } });
}
```

- [ ] **Step 2: Create the public item page**

Create `src/app/i/[itemId]/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { listReceiptsForItem } from "@/modules/transfers/transfers.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";

function partyLabel(p: { isDcsim: boolean; name: string; rank: string | null; unit: string | null }): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const head = p.rank ? `${p.rank} ${p.name}` : p.name;
  return p.unit ? `${head} (${p.unit})` : head;
}

export default async function PublicItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [receipts, qr] = await Promise.all([
    listReceiptsForItem(item.id),
    itemQrDataUrl(item.id).catch(() => ""),
  ]);
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <Link href="/" className="btn btn-ghost btn-sm">Search</Link>
        </div>
      </header>
      <main className="container container-mid stack">
        <div className="row">
          <div>
            <h1 className="page-title">{item.make} {item.model}</h1>
            <p className="subtle">Serial {item.serialNumber}{item.homeUnit ? ` · ${item.homeUnit}` : ""}</p>
          </div>
          <span className="spacer" />
          <StatusBadge status={item.status} />
        </div>

        {qr && (
          <div className="card stack-sm" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item · {itemUrl(item.id)}</p>
          </div>
        )}

        <div className="card">
          <div className="card__title">Hand receipts</div>
          {receipts.length === 0 ? (
            <p className="subtle">No hand receipts recorded for this item yet.</p>
          ) : (
            <ul className="stack-sm">
              {receipts.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    <div><Link href={`/receipts/${t.receiptNumber}`}><strong>{t.receiptNumber}</strong></Link></div>
                    <div className="subtle">
                      {partyLabel({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}
                      {" → "}
                      {partyLabel({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}
                      {" · "}{formatDateTimeHST(t.createdAt)}
                    </div>
                  </div>
                  <span className="spacer" />
                  <a className="btn btn-secondary btn-sm" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Create the admin QR page** (under the admin layout, which already enforces `requireAdmin`)

Create `src/app/admin/items/[itemId]/qr/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";

export default async function QrPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const png = await itemQrDataUrl(item.id);
  const url = itemUrl(item.id);
  return (
    <div className="card qr-card stack">
      <div>
        <h1 className="page-title" style={{ fontSize: 22 }}>{item.make} {item.model}</h1>
        <p className="subtle">Serial {item.serialNumber}</p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={png} alt={`QR code for ${item.make} ${item.model}`} width={320} height={320} style={{ margin: "0 auto" }} />
      <p className="qr-url">{url}</p>
      <div className="row no-print" style={{ justifyContent: "center" }}>
        <a href={`/admin/items/${item.id}/qr/pdf`} className="btn btn-primary">Download label (PDF)</a>
        <Link href="/items" className="btn btn-ghost">Back to items</Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the admin QR PDF route** (route handlers bypass layouts — guard here)

Create `src/app/admin/items/[itemId]/qr/pdf/route.ts`:
```ts
import { requireAdmin, AuthError } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { buildItemQrPdf } from "@/modules/receipts/qr-pdf";

export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.code, { status: e.code === "FORBIDDEN" ? 403 : 401 });
    throw e;
  }
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) return new Response("Not found", { status: 404 });
  const bytes = await buildItemQrPdf(item);
  const filename = `qr-${item.serialNumber}.pdf`.replace(/[^\w.\-]+/g, "_");
  return new Response(Buffer.from(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` },
  });
}
```

- [ ] **Step 5: Add the admin "QR" action on `/items`**

In `src/app/items/page.tsx`, inside the admin-only actions (next to the `Edit` link), add a QR link. In the row's `<div className="actions" …>`, immediately before the `{isAdmin && <Link … >Edit</Link>}` line, add:
```tsx
{isAdmin && <Link href={`/admin/items/${it.id}/qr`} className="btn btn-ghost btn-sm">QR</Link>}
```

- [ ] **Step 6: Open `/i/*` in the proxy matcher**

In `src/proxy.ts`, add `i/` to the negative lookahead:
```ts
  matcher: ["/((?!api/auth|login|register|receipts/|i/|_next/static|_next/image|favicon.ico|$).*)"],
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` (0 errors) and `npm run build` (succeeds — confirm `/i/[itemId]`, `/admin/items/[itemId]/qr`, `/admin/items/[itemId]/qr/pdf` in the route list). `npm test` unchanged-green. Manual (after a receipt exists): `/i/<id>` shows item + QR + receipts; unknown id → 404; `/admin/items/<id>/qr` (as admin) shows QR + Download label.

- [ ] **Step 8: Commit**

```bash
git add src/app/i src/app/admin/items src/modules/transfers/transfers.service.ts src/app/items/page.tsx src/proxy.ts
git commit -m "feat(items): public item page + admin QR label pages; open /i publicly"
```

---

## Task 4: Search with a mode dropdown

**Files:**
- Modify: `src/modules/items/items.service.ts`, `src/modules/items/items.service.test.ts`
- Create: `src/app/actions/search.ts`, `src/app/actions/search.test.ts`, `src/components/HomeSearch.tsx`
- Modify: `src/app/page.tsx`
- Delete: `src/components/ReceiptSearch.tsx`, `src/app/actions/receipts.ts`; remove `searchReceipts` from `transfers.service.ts` if unused

**Interfaces:**
- Consumes: `getTransferByReceiptNumber` (existing); `redirect` (next/navigation).
- Produces: `searchItemsBySerial(q): Promise<Item[]>`; `searchAction(_prev, formData)` → `{ error }` | `{ results: ItemResult[] }` | (redirect); `ItemResult = { id, make, model, serialNumber, status }`.

- [ ] **Step 1: Write a failing searchItemsBySerial test**

Add to `src/modules/items/items.service.test.ts` (create the file if absent; follow the repo's prisma-mock style):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { item: { findMany: vi.fn(async () => []) } } }));
import prisma from "@/lib/prisma";
import { searchItemsBySerial } from "./items.service";

beforeEach(() => vi.clearAllMocks());

describe("searchItemsBySerial", () => {
  it("returns [] for a blank query without hitting the DB", async () => {
    expect(await searchItemsBySerial("  ")).toEqual([]);
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });
  it("queries by serialNumber contains, case-insensitive", async () => {
    await searchItemsBySerial("sn12");
    const where = (prisma.item.findMany as any).mock.calls[0][0].where;
    expect(where.serialNumber.contains).toBe("sn12");
    expect(where.serialNumber.mode).toBe("insensitive");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- items.service`
Expected: FAIL — `searchItemsBySerial` not exported.

- [ ] **Step 3: Implement searchItemsBySerial**

In `src/modules/items/items.service.ts`, add:
```ts
export function searchItemsBySerial(q: string): Promise<Item[]> {
  const s = q.trim();
  if (!s) return Promise.resolve([]);
  return prisma.item.findMany({
    where: { serialNumber: { contains: s, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- items.service`
Expected: PASS.

- [ ] **Step 5: Write a failing searchAction test**

Create `src/app/actions/search.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
const searchItemsBySerial = vi.fn();
const getTransferByReceiptNumber = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n) }));

import { searchAction } from "./search";

function fd(o: Record<string, string>): FormData { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; }
beforeEach(() => vi.clearAllMocks());

describe("searchAction", () => {
  it("errors on a blank query", async () => {
    expect(await searchAction(undefined, fd({ mode: "serial", query: "  " }))).toEqual({ error: "Enter a search term." });
  });
  it("serial: redirects to the item on a single match", async () => {
    searchItemsBySerial.mockResolvedValue([{ id: "itm1", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" }]);
    await expect(searchAction(undefined, fd({ mode: "serial", query: "SN1" }))).rejects.toThrow("REDIRECT:/i/itm1");
  });
  it("serial: returns a results list on multiple matches", async () => {
    searchItemsBySerial.mockResolvedValue([
      { id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" },
      { id: "b", make: "HP", model: "E", serialNumber: "SN12", status: "ACTIVE" },
    ]);
    const r = await searchAction(undefined, fd({ mode: "serial", query: "SN1" }));
    expect(r).toEqual({ results: [
      { id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" },
      { id: "b", make: "HP", model: "E", serialNumber: "SN12", status: "ACTIVE" },
    ] });
  });
  it("receipt: redirects to the receipt when found", async () => {
    getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000042" });
    await expect(searchAction(undefined, fd({ mode: "receipt", query: "hr-000042" }))).rejects.toThrow("REDIRECT:/receipts/HR-000042");
  });
  it("receipt: errors when not found", async () => {
    getTransferByReceiptNumber.mockResolvedValue(null);
    expect(await searchAction(undefined, fd({ mode: "receipt", query: "HR-999" }))).toEqual({ error: "No hand receipt found with that number." });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- actions/search`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement searchAction**

Create `src/app/actions/search.ts`:
```ts
"use server";
import { redirect } from "next/navigation";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };

export async function searchAction(_prev: unknown, formData: FormData) {
  const mode = String(formData.get("mode") ?? "serial") === "receipt" ? "receipt" : "serial";
  const query = String(formData.get("query") ?? "").trim();
  if (!query) return { error: "Enter a search term." };

  if (mode === "receipt") {
    const t = await getTransferByReceiptNumber(query);
    if (!t) return { error: "No hand receipt found with that number." };
    redirect(`/receipts/${t.receiptNumber}`);
  }

  const items = await searchItemsBySerial(query);
  if (items.length === 0) return { error: "No items found with that serial number." };
  if (items.length === 1) redirect(`/i/${items[0].id}`);
  const results: ItemResult[] = items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status }));
  return { results };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- actions/search`
Expected: PASS.

- [ ] **Step 9: Build the HomeSearch component + swap it in**

Create `src/components/HomeSearch.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { searchAction, type ItemResult } from "@/app/actions/search";

export function HomeSearch() {
  const [state, action, pending] = useActionState(searchAction, undefined);
  const results: ItemResult[] | undefined = state && "results" in state ? state.results : undefined;
  return (
    <div className="stack">
      <form action={action} className="row">
        <select className="select" name="mode" defaultValue="serial" aria-label="Search by">
          <option value="serial">Serial number</option>
          <option value="receipt">Hand receipt number</option>
        </select>
        <input className="input" name="query" placeholder="Search…" required aria-label="Search" />
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Searching…" : "Search"}</button>
      </form>
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
      {results && results.length > 0 && (
        <ul className="stack-sm">
          {results.map((r) => (
            <li key={r.id} className="card row">
              <div>
                <div><strong>{r.make} {r.model}</strong></div>
                <div className="subtle">SN {r.serialNumber} · {r.status}</div>
              </div>
              <span className="spacer" />
              <a className="btn btn-secondary btn-sm" href={`/i/${r.id}`}>View item</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

In `src/app/page.tsx`: replace `import { ReceiptSearch } from "@/components/ReceiptSearch";` with `import { HomeSearch } from "@/components/HomeSearch";`, replace `<ReceiptSearch />` with `<HomeSearch />`, and update the heading/subtitle copy to:
```tsx
          <h1 className="page-title">Find an item or hand receipt</h1>
          <p className="subtle">Search by item serial number, or look up a hand receipt by its number (HR-XXXXXX).</p>
```

- [ ] **Step 10: Remove the old receipt search**

```bash
git rm src/components/ReceiptSearch.tsx src/app/actions/receipts.ts
```
Then remove `searchReceipts` from `src/modules/transfers/transfers.service.ts` **if** `git grep -n "searchReceipts" -- src` shows no remaining callers (also drop its test case in `transfers.service.test.ts` if present).

- [ ] **Step 11: Full verification**

Run: `npx tsc --noEmit` (0), `npm run lint` (clean), `npm test` (all pass), `npm run build` (succeeds). `git grep -n "ReceiptSearch\|searchReceiptsAction\|searchReceipts" -- src` → no matches in live code.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(search): home search with serial/receipt mode dropdown; drop receipt-only search"
```

---

## Task 5: Final verification & smoke checklist

- [ ] **Step 1: Full gates** — `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.
- [ ] **Step 2: Document the manual smoke checklist** in the task report (run after deploy):
  1. Create a new transfer → its receipt number is `HR-0000NN` (sequential), not hex.
  2. Public `/` search: mode "Serial number" + partial SN → single match redirects to `/i/[id]`; multiple → list; mode "Hand receipt number" + `HR-0000NN` → the receipt page.
  3. `/i/[id]` (logged out) shows item + QR + receipt history with working Download PDF.
  4. As admin, `/items` shows a "QR" action → `/admin/items/[id]/qr` → Download label (PDF) opens a QR label.
  5. Scanning the item QR opens `/i/[id]`.
- [ ] **Step 3: Commit** any doc change (skip if none).

---

## Self-Review (coverage map)

- **Public item page (item + receipt history + PDF)** → Task 3 (`/i/[itemId]`, `listReceiptsForItem`).
- **Item QR: admin label PDF + on-page** → Task 2 (helpers + `buildItemQrPdf`), Task 3 (admin pages + on-page QR + `/items` action).
- **Search dropdown (serial→item, receipt→receipt)** → Task 4 (`searchAction`, `HomeSearch`, `searchItemsBySerial`).
- **Sequential HR-000001 numbers** → Task 1 (sequence migration + `createTransfer`).
- **`/i/*` public; admin QR admin-only** → Task 3 (proxy + admin layout/route guards).
- **Remove receipt-only search** → Task 4 (delete `ReceiptSearch`/`receipts.ts`/`searchReceipts`).
