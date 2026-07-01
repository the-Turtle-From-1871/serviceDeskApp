# Hand Receipt App — Plan 2: Items & QR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins log items (make, model, serial, asset tag, home location, notes), each item gets a printable QR code, and scanning the QR opens `/i/<itemId>` showing read-only details to anyone (login required to act — actions land in Plan 3).

**Architecture:** Item domain logic in `src/modules/items/items.service.ts` (the only place items are created/edited/retired). QR generation isolated in `src/modules/items/qr.ts`. Admin UI under `src/app/admin/*`; public/authenticated item detail at `src/app/i/[itemId]/page.tsx`. Integration tests run against a real Postgres test DB, truncated between tests.

**Tech Stack:** Same as Plan 1, plus `qrcode` for PNG data-URLs.

**Prerequisite:** Plan 1 complete (auth, roles, `requireUser`/`requireAdmin`, `prisma`).

## Global Constraints

- Item creation/edit/retire is **admin-only** (`requireAdmin`). Item reads are public read-only at `/i/<itemId>`.
- All input validated with zod at the service boundary; reject with a typed error, never persist partial data.
- `currentHolderId` is nullable and is **only** mutated by the transfers module (Plan 3). Plan 2 sets it only at creation if an initial holder is chosen — via the transfers module's initial-assignment path is deferred to Plan 3; in Plan 2 items are created **unassigned** (`currentHolderId = null`). (Noted so Plan 3 wires initial assignment.)
- QR encodes the absolute URL `${APP_URL}/i/${itemId}`.
- Enums: `ItemStatus = { ACTIVE, RETIRED }`.

## Integration Test Harness (used by Tasks 2, 5)

Tests use `.env.test`'s `DATABASE_URL` (database `handreceipt_test`). Before the suite, migrations are applied; before each test, tables are truncated.

Create `tests/helpers/db.ts`:
```typescript
import { execSync } from "node:child_process";
import prisma from "@/lib/prisma";

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Transfer","Item","User" RESTART IDENTITY CASCADE;`
  );
}

export function migrateTestDb() {
  execSync("prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "inherit",
  });
}
```
(The `Transfer` table does not exist until Plan 3; until then, change the TRUNCATE to `"Item","User"`. Plan 3 Task 1 updates this helper to include `Transfer`.)

Add to `vitest.config.ts` a setup that loads `.env.test`:
```typescript
// add to test config:
setupFiles: ["tests/helpers/setup-env.ts"],
```
Create `tests/helpers/setup-env.ts`:
```typescript
import { config } from "dotenv";
config({ path: ".env.test" });
```
Install: `npm install -D dotenv`.

---

### Task 1: Item + Transfer schema, ItemStatus enum

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Item` model and the `ItemStatus` enum; a forward-declared `Transfer` model (fully used in Plan 3) so relations compile now. Adds `currentHolderId` relation on `Item`.

- [ ] **Step 1: Add enum + models to prisma/schema.prisma**

Append:
```prisma
enum ItemStatus {
  ACTIVE
  RETIRED
}

model Item {
  id            String     @id @default(cuid())
  make          String
  model         String
  serialNumber  String
  assetTag      String?
  homeLocation  String?
  notes         String?
  status        ItemStatus @default(ACTIVE)
  currentHolder User?      @relation("CurrentHolder", fields: [currentHolderId], references: [id])
  currentHolderId String?
  createdBy     User       @relation("CreatedItems", fields: [createdById], references: [id])
  createdById   String
  transfers     Transfer[]
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt
}
```
Add these relation fields to the existing `User` model:
```prisma
  createdItems  Item[]     @relation("CreatedItems")
  heldItems     Item[]     @relation("CurrentHolder")
  transfersFrom Transfer[] @relation("TransferFrom")
  transfersTo   Transfer[] @relation("TransferTo")
```
Add the forward-declared Transfer model (completed in Plan 3):
```prisma
enum TransferStatus {
  PENDING
  COMPLETED
  CANCELLED
}

model Transfer {
  id             String         @id @default(cuid())
  item           Item           @relation(fields: [itemId], references: [id])
  itemId         String
  fromUser       User?          @relation("TransferFrom", fields: [fromUserId], references: [id])
  fromUserId     String?
  toUser         User           @relation("TransferTo", fields: [toUserId], references: [id])
  toUserId       String
  status         TransferStatus @default(PENDING)
  isOverride     Boolean        @default(false)
  actingAdminId  String?
  signatureImage String?
  fromUserName   String?
  toUserName     String
  itemSummary    String
  initiatedAt    DateTime       @default(now())
  signedAt       DateTime?
  cancelledAt    DateTime?
}
```

- [ ] **Step 2: Create the migration**

Run: `npm run db:migrate -- --name items_transfers`
Expected: migration applied; `Item`, `Transfer` tables exist.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Item and Transfer schema with status enums"
```

---

### Task 2: Items service — create/get/list/update/retire (TDD)

**Files:**
- Create: `src/modules/items/items.service.ts`
- Create: `src/modules/items/items.schema.ts`
- Test: `src/modules/items/items.service.test.ts`

**Interfaces:**
- Consumes: `prisma`.
- Produces:
  - `createItem(input: NewItemInput, createdById: string): Promise<Item>`
  - `getItem(id: string): Promise<ItemWithHolder | null>` (includes `currentHolder`)
  - `listItems(opts?: { search?: string }): Promise<ItemWithHolder[]>`
  - `updateItem(id: string, input: Partial<NewItemInput>): Promise<Item>`
  - `retireItem(id: string): Promise<Item>` (sets `status = RETIRED`)
  - `NewItemInput` from `items.schema.ts`: `{ make, model, serialNumber, assetTag?, homeLocation?, notes? }` (make/model/serialNumber required, trimmed, non-empty).

- [ ] **Step 1: Write the zod schema**

`src/modules/items/items.schema.ts`:
```typescript
import { z } from "zod";

export const newItemSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  serialNumber: z.string().trim().min(1, "Serial number is required"),
  assetTag: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined),
  homeLocation: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined),
  notes: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined),
});

export type NewItemInput = z.infer<typeof newItemSchema>;
```

- [ ] **Step 2: Write the failing test**

`src/modules/items/items.service.test.ts`:
```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, getItem, listItems, updateItem, retireItem } from "./items.service";

let adminId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

test("createItem persists required fields and defaults", async () => {
  const item = await createItem(
    { make: "Dell", model: "5540", serialNumber: "SN1" },
    adminId
  );
  expect(item.make).toBe("Dell");
  expect(item.status).toBe("ACTIVE");
  expect(item.currentHolderId).toBeNull();
  expect(item.createdById).toBe(adminId);
});

test("createItem rejects blank serial number", async () => {
  await expect(
    createItem({ make: "Dell", model: "5540", serialNumber: "   " }, adminId)
  ).rejects.toThrow();
});

test("getItem includes current holder relation", async () => {
  const created = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const found = await getItem(created.id);
  expect(found?.id).toBe(created.id);
  expect(found).toHaveProperty("currentHolder");
});

test("listItems search matches serial number", async () => {
  await createItem({ make: "Dell", model: "A", serialNumber: "ABC123" }, adminId);
  await createItem({ make: "HP", model: "B", serialNumber: "ZZZ999" }, adminId);
  const results = await listItems({ search: "ABC" });
  expect(results).toHaveLength(1);
  expect(results[0].serialNumber).toBe("ABC123");
});

test("retireItem sets status RETIRED", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const retired = await retireItem(item.id);
  expect(retired.status).toBe("RETIRED");
});

test("updateItem changes editable fields", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const updated = await updateItem(item.id, { homeLocation: "Cage 3" });
  expect(updated.homeLocation).toBe("Cage 3");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- items.service`
Expected: FAIL (service module not found).

- [ ] **Step 4: Write minimal implementation**

`src/modules/items/items.service.ts`:
```typescript
import type { Item } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";

export type ItemWithHolder = Awaited<ReturnType<typeof getItem>>;

export async function createItem(input: NewItemInput, createdById: string): Promise<Item> {
  const data = newItemSchema.parse(input);
  return prisma.item.create({ data: { ...data, createdById } });
}

export function getItem(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: { currentHolder: { select: { id: true, name: true } } },
  });
}

export function listItems(opts: { search?: string } = {}) {
  const search = opts.search?.trim();
  return prisma.item.findMany({
    where: search
      ? {
          OR: [
            { make: { contains: search, mode: "insensitive" } },
            { model: { contains: search, mode: "insensitive" } },
            { serialNumber: { contains: search, mode: "insensitive" } },
            { assetTag: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: { currentHolder: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateItem(id: string, input: Partial<NewItemInput>): Promise<Item> {
  const data = newItemSchema.partial().parse(input);
  return prisma.item.update({ where: { id }, data });
}

export function retireItem(id: string): Promise<Item> {
  return prisma.item.update({ where: { id }, data: { status: "RETIRED" } });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- items.service`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: items service with create/get/list/update/retire"
```

---

### Task 3: QR code generation (TDD)

**Files:**
- Create: `src/modules/items/qr.ts`
- Test: `src/modules/items/qr.test.ts`

**Interfaces:**
- Produces:
  - `itemUrl(itemId: string, baseUrl?: string): string` → `${baseUrl}/i/${itemId}` (baseUrl defaults to `process.env.APP_URL`).
  - `itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string>` → a `data:image/png;base64,...` PNG of the item URL.

- [ ] **Step 1: Write the failing test**

`src/modules/items/qr.test.ts`:
```typescript
import { expect, test } from "vitest";
import { itemUrl, itemQrDataUrl } from "./qr";

test("itemUrl builds the absolute item link", () => {
  expect(itemUrl("abc", "https://hr.example")).toBe("https://hr.example/i/abc");
});

test("itemQrDataUrl returns a png data url", async () => {
  const url = await itemQrDataUrl("abc", "https://hr.example");
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- qr`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/modules/items/qr.ts`:
```typescript
import QRCode from "qrcode";

export function itemUrl(itemId: string, baseUrl = process.env.APP_URL ?? ""): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${itemId}`;
}

export function itemQrDataUrl(itemId: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(itemUrl(itemId, baseUrl), { margin: 1, width: 320 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- qr`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: QR code URL + PNG data-url generation"
```

---

### Task 4: Admin — create item form + server action

**Files:**
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/items/new/page.tsx`
- Create: `src/app/admin/actions/items.ts`

**Interfaces:**
- Consumes: `createItem` (Task 2), `requireAdmin` (Plan 1), `newItemSchema` (Task 2).
- Produces: `createItemAction(prev, formData)` server action returning `{ error?, itemId? }`; the admin layout guards `/admin/*` with `requireAdmin` and renders nav + sign out.

- [ ] **Step 1: Admin layout guard**

`src/app/admin/layout.tsx`:
```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 900, margin: "2rem auto" }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <Link href="/admin/items">Items</Link>
        <Link href="/admin/items/new">New item</Link>
        <Link href="/admin/users">Users</Link>
        <Link href="/admin/audit">Audit</Link>
        <span style={{ marginLeft: "auto" }}><SignOutButton /></span>
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create item server action**

`src/app/admin/actions/items.ts`:
```typescript
"use server";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import { createItem } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const item = await createItem(parsed.data, admin.id);
  return { itemId: item.id };
}
```

- [ ] **Step 3: Create the new-item page**

`src/app/admin/items/new/page.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["assetTag", "Asset tag", false],
  ["homeLocation", "Home location", false],
  ["notes", "Notes", false],
] as const;

export default function NewItemPage() {
  const [state, action, pending] = useActionState(createItemAction, undefined);
  if (state && "itemId" in state && state.itemId) {
    return (
      <div>
        <h1>Item created</h1>
        <p><Link href={`/admin/items/${state.itemId}/qr`}>View / print QR code →</Link></p>
        <p><Link href="/admin/items/new">Add another</Link></p>
      </div>
    );
  }
  return (
    <div>
      <h1>New item</h1>
      <form action={action}>
        {fields.map(([name, label, req]) => (
          <label key={name} style={{ display: "block", marginBottom: 8 }}>
            {label}{req ? " *" : ""}
            <input name={name} required={req} style={{ width: "100%" }} />
          </label>
        ))}
        {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
        <button disabled={pending} type="submit">{pending ? "Saving…" : "Create item"}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Manual verification**

Sign in as admin, go to `/admin/items/new`, submit an item → "Item created" with a QR link (QR page built in Task 5). Submitting a blank make → error message.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: admin create-item form + guarded admin layout"
```

---

### Task 5: Admin — items list + QR print page

**Files:**
- Create: `src/app/admin/items/page.tsx`
- Create: `src/app/admin/items/[itemId]/qr/page.tsx`
- Create: `src/components/PrintButton.tsx`

**Interfaces:**
- Consumes: `listItems`, `getItem` (Task 2), `itemQrDataUrl`, `itemUrl` (Task 3).
- Produces: admin items list with search; a QR page rendering the PNG + item URL with a print button.

- [ ] **Step 1: Items list page (server component)**

`src/app/admin/items/page.tsx`:
```tsx
import Link from "next/link";
import { listItems } from "@/modules/items/items.service";

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const items = await listItems({ search: q });
  return (
    <div>
      <h1>Items</h1>
      <form><input name="q" defaultValue={q ?? ""} placeholder="Search make/model/serial/tag" /><button>Search</button></form>
      <table>
        <thead><tr><th>Make</th><th>Model</th><th>Serial</th><th>Holder</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.make}</td><td>{it.model}</td><td>{it.serialNumber}</td>
              <td>{it.currentHolder?.name ?? "—"}</td><td>{it.status}</td>
              <td>
                <Link href={`/i/${it.id}`}>View</Link>{" · "}
                <Link href={`/admin/items/${it.id}/qr`}>QR</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Print button (client)**

`src/components/PrintButton.tsx`:
```tsx
"use client";
export function PrintButton() {
  return <button onClick={() => window.print()}>Print</button>;
}
```

- [ ] **Step 3: QR page (server component)**

`src/app/admin/items/[itemId]/qr/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { PrintButton } from "@/components/PrintButton";

export default async function QrPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [png, url] = await Promise.all([itemQrDataUrl(item.id), Promise.resolve(itemUrl(item.id))]);
  return (
    <div style={{ textAlign: "center" }}>
      <h1>{item.make} {item.model}</h1>
      <p>Serial: {item.serialNumber}{item.assetTag ? ` · Tag: ${item.assetTag}` : ""}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={png} alt={`QR code for ${item.make} ${item.model}`} width={320} height={320} />
      <p style={{ fontSize: 12, wordBreak: "break-all" }}>{url}</p>
      <PrintButton />
    </div>
  );
}
```

- [ ] **Step 4: Manual verification**

From the items list, click "QR" → QR image + URL render; "Print" opens the print dialog. Scanning the QR with a phone opens `/i/<id>` (built next task) — set `APP_URL` to your machine's LAN address (e.g. `http://192.168.x.x:3000`) so phones can reach it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: admin items list + printable QR page"
```

---

### Task 6: Public item detail page `/i/[itemId]`

**Files:**
- Create: `src/app/i/[itemId]/page.tsx`
- Create: `src/components/ItemDetails.tsx`

**Interfaces:**
- Consumes: `getItem` (Task 2), `auth` (Plan 1). Transfer history + actions arrive in Plan 3; this task renders details + current holder and a login prompt for unauthenticated visitors.
- Produces: `ItemDetails` presentational component reused by admin/public views. A `<section id="history">` placeholder is included with the text "Transfer history appears here" — replaced in Plan 3 Task 5.

- [ ] **Step 1: ItemDetails component**

`src/components/ItemDetails.tsx`:
```tsx
type Props = {
  item: {
    make: string; model: string; serialNumber: string;
    assetTag: string | null; homeLocation: string | null; notes: string | null;
    status: string; currentHolder: { name: string } | null;
  };
};
export function ItemDetails({ item }: Props) {
  const rows: [string, string][] = [
    ["Make", item.make], ["Model", item.model], ["Serial number", item.serialNumber],
    ["Asset tag", item.assetTag ?? "—"], ["Home location", item.homeLocation ?? "—"],
    ["Status", item.status], ["Current holder", item.currentHolder?.name ?? "Unassigned"],
  ];
  return (
    <dl>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 8 }}>
          <dt style={{ fontWeight: 600, minWidth: 140 }}>{k}</dt><dd>{v}</dd>
        </div>
      ))}
      {item.notes && <p><em>{item.notes}</em></p>}
    </dl>
  );
}
```

- [ ] **Step 2: Item detail page (public read-only)**

`src/app/i/[itemId]/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getItem } from "@/modules/items/items.service";
import { ItemDetails } from "@/components/ItemDetails";

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const session = await auth();
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto" }}>
      <h1>{item.make} {item.model}</h1>
      <ItemDetails item={item} />
      <section id="history">
        <h2>Transfer history</h2>
        <p>Transfer history appears here.</p>
      </section>
      {!session?.user && <p><Link href="/login">Sign in</Link> to transfer or sign for this item.</p>}
      {/* Holder actions (Initiate transfer) added in Plan 3. */}
    </main>
  );
}
```
Note: middleware from Plan 1 already excludes `/i/` from the auth gate, so this page is publicly reachable.

- [ ] **Step 3: Manual verification**

Log out. Visit `/i/<validId>` → details render read-only with a "Sign in" prompt. Visit `/i/bogus` → 404. Log in → prompt disappears.

- [ ] **Step 4: E2E — public read-only scan**

Create `tests/e2e/item-public.spec.ts`:
```typescript
import { expect, test } from "@playwright/test";

// Assumes at least one item exists; create via admin UI or a seed before running.
test("unauthenticated visitor can view item details but sees sign-in prompt", async ({ page, request }) => {
  // Create an item through admin session is out of scope here; this test navigates to a known seeded item id via env.
  const itemId = process.env.E2E_ITEM_ID;
  test.skip(!itemId, "Set E2E_ITEM_ID to a real item to run this test");
  await page.goto(`/i/${itemId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Sign in")).toBeVisible();
});
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: public item detail page with read-only details"
```

---

## Self-Review

- **Spec coverage:** Item fields make/model/serial/assetTag/homeLocation/notes ✅ Task 1/2. Admin-only create ✅ Task 4 (`requireAdmin`). QR encodes item URL + printable ✅ Task 3/5. Scan → `/i/<id>` read-only details for anyone ✅ Task 6. Search across items ✅ Task 2/5. (Transfer history rendering + actions are Plan 3, explicitly stubbed in Task 6.)
- **Placeholders:** the `#history` "appears here" text and Plan-3 action comment are intentional interim stubs with explicit replacement pointers — not code placeholders. Everything else is concrete.
- **Type consistency:** `getItem` include shape (`currentHolder { name }`) matches `ItemDetails` Props and the list page usage. `NewItemInput`/`newItemSchema` reused by service (Task 2) and action (Task 4). `itemUrl`/`itemQrDataUrl` signatures consistent between Task 3 and Task 5.
