# Annual Audit Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each item an audit status (green = compliant, yellow = overdue, gray = never audited) shown on the items list and item detail page, where an admin technician marks an item audited using a saved signature, logging a permanent history.

**Architecture:** A new `ItemAudit` history table records one row per audit; an item's status is derived from its newest row. A pure status module maps the latest audit date to a three-state value. A server action (`markAuditedAction`) records audits, reusing the named-`Signature` infrastructure and its anti-forgery pattern (client posts only `signatureId`; server re-reads name + image scoped to the acting admin). The list view computes each row's state from a batched latest-date lookup; the detail page shows the light, an admin-only mark-audited control, and the audit history.

**Tech Stack:** Next.js 16 (App Router, Server Components/Actions, React 19), Prisma 7 + PostgreSQL, Zod, Vitest.

## Global Constraints

- Every Server Action checks auth first: `const user = await requireAdmin();` before any work.
- Never trust input IDs: signatures are resolved via `getOwnedSignature(id, user.id)`, scoped to the acting admin.
- Server Actions catch exceptions, return a generic message to the client, and `console.error` the detail server-side.
- Use standard Prisma methods (no raw string-concatenated SQL).
- Audit period is a fixed **1 calendar year** from the last audit date.
- Three audit states: `compliant` (green), `overdue` (yellow), `never` (gray). Retired items show a neutral dash (—), not a light, and cannot be audited.
- The audit light is visible to all logged-in users; only admins can mark items audited.
- Follow existing module patterns: pure logic modules with unit tests (mirror `service-queue.status.ts`), services that wrap Prisma (mirror `service-queue.service.ts`), actions under `src/app/admin/actions/` (mirror `queue.ts`).
- Tests mock `@/lib/prisma` and dependencies (mirror `service-queue.service.test.ts` and `returns.test.ts`). **Do not run the full suite concurrently with other agents — they share one test DB.**

---

### Task 1: Schema + migration for `ItemAudit`

**Files:**
- Modify: `prisma/schema.prisma` (Item model ~line 89, User model ~line 43, and append the new model)
- Create: `prisma/migrations/20260716000000_item_audit/migration.sql`

**Interfaces:**
- Produces: Prisma model `ItemAudit { id, itemId, auditedById?, auditedByName, signerName, signatureImage, createdAt }`; relation `Item.audits`; relation `User.itemAudits`. Generated client type `ItemAudit` from `@prisma/client`.

- [ ] **Step 1: Add the `ItemAudit` model and relations to `prisma/schema.prisma`**

Append this model at the end of the file:

```prisma
// History of possession audits for an item. One row per audit event; an item's
// audit status is derived from the newest row (see modules/audit/audit.status.ts).
// Nullable auditor + denormalized name/signature snapshots so history survives
// deletion of the acting account or the source Signature (mirrors ItemEdit /
// ReturnTransaction).
model ItemAudit {
  id             String   @id @default(cuid())
  item           Item     @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId         String
  auditedBy      User?    @relation("ItemAudits", fields: [auditedById], references: [id], onDelete: SetNull)
  auditedById    String?
  auditedByName  String
  signerName     String
  signatureImage String
  createdAt      DateTime @default(now())

  @@index([itemId, createdAt])
}
```

In the `Item` model, add to the relation block (next to `serviceQueueItem`/`edits`):

```prisma
  audits           ItemAudit[]
```

In the `User` model, add to the relation block (next to `itemEdits`):

```prisma
  itemAudits       ItemAudit[]          @relation("ItemAudits")
```

- [ ] **Step 2: Create the migration SQL**

Create `prisma/migrations/20260716000000_item_audit/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "ItemAudit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "auditedById" TEXT,
    "auditedByName" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signatureImage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemAudit_itemId_createdAt_idx" ON "ItemAudit"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "ItemAudit" ADD CONSTRAINT "ItemAudit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAudit" ADD CONSTRAINT "ItemAudit_auditedById_fkey" FOREIGN KEY ("auditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

> Note: this shell cannot run `prisma migrate dev`. The SQL above is authored by hand and applied with `migrate deploy`. If you prefer to regenerate it, use `npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script` and compare — the output should match.

- [ ] **Step 3: Apply the migration and regenerate the client**

Run:
```bash
npx prisma migrate deploy
npx prisma generate
```
Expected: `migrate deploy` reports the `20260716000000_item_audit` migration applied; `generate` succeeds.

- [ ] **Step 4: Verify migration status and type generation**

Run:
```bash
npx prisma migrate status
```
Expected: "Database schema is up to date!" (no pending migrations).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260716000000_item_audit/migration.sql
git commit -m "feat(audit): add ItemAudit history table"
```

---

### Task 2: Audit status pure module

**Files:**
- Create: `src/modules/audit/audit.status.ts`
- Test: `src/modules/audit/audit.status.test.ts`

**Interfaces:**
- Produces:
  - `type AuditState = "compliant" | "overdue" | "never"`
  - `const AUDIT_PERIOD_YEARS = 1`
  - `auditState(lastAuditedAt: Date | null, now: Date): AuditState`
  - `auditStateDisplay(state: AuditState): { label: string; className: string }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/audit/audit.status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { auditState, auditStateDisplay } from "./audit.status";

describe("auditState", () => {
  it("returns 'never' when there is no audit date", () => {
    expect(auditState(null, new Date("2026-07-16T00:00:00Z"))).toBe("never");
  });

  it("returns 'compliant' within one year of the last audit", () => {
    const last = new Date("2026-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-12-31T00:00:00Z"))).toBe("compliant");
  });

  it("returns 'overdue' exactly one year later (boundary is not compliant)", () => {
    const last = new Date("2025-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-01-01T00:00:00Z"))).toBe("overdue");
  });

  it("returns 'overdue' more than one year after the last audit", () => {
    const last = new Date("2024-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-07-16T00:00:00Z"))).toBe("overdue");
  });

  it("handles a leap-day audit (2024-02-29 + 1yr normalizes to 2025-03-01)", () => {
    const last = new Date("2024-02-29T00:00:00Z");
    expect(auditState(last, new Date("2025-02-28T00:00:00Z"))).toBe("compliant");
    expect(auditState(last, new Date("2025-03-02T00:00:00Z"))).toBe("overdue");
  });
});

describe("auditStateDisplay", () => {
  it("maps each state to a label and dot class", () => {
    expect(auditStateDisplay("compliant")).toEqual({ label: "Compliant", className: "audit-dot--compliant" });
    expect(auditStateDisplay("overdue")).toEqual({ label: "Overdue", className: "audit-dot--overdue" });
    expect(auditStateDisplay("never")).toEqual({ label: "Never audited", className: "audit-dot--never" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/audit/audit.status.test.ts`
Expected: FAIL — cannot find module `./audit.status`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/audit/audit.status.ts`:

```ts
// Pure audit-status logic. An item's status is derived from its most recent audit
// date. Kept free of Prisma/React so it is unit-testable (mirrors
// service-queue.status.ts).

export type AuditState = "compliant" | "overdue" | "never";

export const AUDIT_PERIOD_YEARS = 1;

// null lastAuditedAt -> "never". Compliant while `now` is before the audit date
// plus one calendar year; "overdue" from that instant on (the boundary itself is
// overdue). setFullYear handles leap days by normalizing (Feb 29 -> Mar 1).
export function auditState(lastAuditedAt: Date | null, now: Date): AuditState {
  if (!lastAuditedAt) return "never";
  const expiry = new Date(lastAuditedAt);
  expiry.setFullYear(expiry.getFullYear() + AUDIT_PERIOD_YEARS);
  return now.getTime() < expiry.getTime() ? "compliant" : "overdue";
}

export function auditStateDisplay(state: AuditState): { label: string; className: string } {
  switch (state) {
    case "compliant":
      return { label: "Compliant", className: "audit-dot--compliant" };
    case "overdue":
      return { label: "Overdue", className: "audit-dot--overdue" };
    case "never":
      return { label: "Never audited", className: "audit-dot--never" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/audit/audit.status.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/audit/audit.status.ts src/modules/audit/audit.status.test.ts
git commit -m "feat(audit): add pure audit-status module"
```

---

### Task 3: Audit service module

**Files:**
- Create: `src/modules/audit/audit.service.ts`
- Test: `src/modules/audit/audit.service.test.ts`

**Interfaces:**
- Consumes: `@prisma/client` types, `@/lib/prisma`.
- Produces:
  - `type RecordAuditInput = { itemId: string; auditedById: string; auditedByName: string; signerName: string; signatureImage: string }`
  - `recordAudit(input: RecordAuditInput): Promise<ItemAudit>`
  - `getAuditsForItem(itemId: string): Promise<ItemAudit[]>` (newest first)
  - `getLatestAuditMap(itemIds: string[]): Promise<Map<string, Date>>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/audit/audit.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    itemAudit: {
      create: vi.fn(async () => ({ id: "a1" })),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  },
}));

import prisma from "@/lib/prisma";
import { recordAudit, getAuditsForItem, getLatestAuditMap } from "./audit.service";

beforeEach(() => vi.clearAllMocks());

describe("recordAudit", () => {
  it("creates one ItemAudit row from the input", async () => {
    await recordAudit({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
    const arg = vi.mocked(prisma.itemAudit.create).mock.calls[0][0];
    expect(arg.data).toMatchObject({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
  });
});

describe("getAuditsForItem", () => {
  it("queries the item's audits newest-first", async () => {
    await getAuditsForItem("i1");
    const arg = vi.mocked(prisma.itemAudit.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });
});

describe("getLatestAuditMap", () => {
  it("returns an empty map for no ids without querying", async () => {
    const map = await getLatestAuditMap([]);
    expect(map.size).toBe(0);
    expect(prisma.itemAudit.groupBy).not.toHaveBeenCalled();
  });

  it("maps each itemId to its newest audit date", async () => {
    const d = new Date("2026-01-01T00:00:00Z");
    vi.mocked(prisma.itemAudit.groupBy).mockResolvedValueOnce([
      { itemId: "i1", _max: { createdAt: d } },
      { itemId: "i2", _max: { createdAt: null } },
    ] as never);
    const map = await getLatestAuditMap(["i1", "i2"]);
    expect(map.get("i1")).toEqual(d);
    expect(map.has("i2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/audit/audit.service.test.ts`
Expected: FAIL — cannot find module `./audit.service`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/audit/audit.service.ts`:

```ts
import type { ItemAudit } from "@prisma/client";
import prisma from "@/lib/prisma";

export type RecordAuditInput = {
  itemId: string;
  auditedById: string;
  auditedByName: string;
  signerName: string;
  signatureImage: string;
};

// Record one audit event. The item's status is derived from the newest row.
export function recordAudit(input: RecordAuditInput): Promise<ItemAudit> {
  return prisma.itemAudit.create({ data: input });
}

// All audits for an item, newest first, for the detail-page history log.
export function getAuditsForItem(itemId: string): Promise<ItemAudit[]> {
  return prisma.itemAudit.findMany({
    where: { itemId },
    orderBy: { createdAt: "desc" },
  });
}

// Newest audit date per item, for the list view. One grouped query; skips items
// with no audit (they stay absent from the map and render as "never").
export async function getLatestAuditMap(itemIds: string[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map();
  const rows = await prisma.itemAudit.groupBy({
    by: ["itemId"],
    where: { itemId: { in: itemIds } },
    _max: { createdAt: true },
  });
  const map = new Map<string, Date>();
  for (const r of rows) if (r._max.createdAt) map.set(r.itemId, r._max.createdAt);
  return map;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/audit/audit.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/audit/audit.service.ts src/modules/audit/audit.service.test.ts
git commit -m "feat(audit): add audit service (record, list, latest-date map)"
```

---

### Task 4: `markAuditedAction` server action

**Files:**
- Create: `src/app/admin/actions/audit.ts`
- Test: `src/app/admin/actions/audit.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (`@/lib/authz`), `getItem` (`@/modules/items/items.service`), `getOwnedSignature` (`@/modules/signatures/signatures.service`), `recordAudit` (`@/modules/audit/audit.service`), `revalidatePath` (`next/cache`).
- Produces: `markAuditedAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }>` — shape compatible with `useActionState`.

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/actions/audit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const getItem = vi.fn();
const getOwnedSignature = vi.fn();
const recordAudit = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireAdmin: () => requireAdmin(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/items/items.service", () => ({
  getItem: (id: string) => getItem(id),
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  getOwnedSignature: (id: string, userId: string) => getOwnedSignature(id, userId),
}));
vi.mock("@/modules/audit/audit.service", () => ({
  recordAudit: (input: unknown) => recordAudit(input),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

import { markAuditedAction } from "./audit";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Sgt Admin", email: "admin@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  getItem.mockResolvedValue({ id: "i1", status: "ACTIVE" });
  getOwnedSignature.mockResolvedValue({ name: "SFC Tech", image: "data:image/png;base64,AAA" });
});

describe("markAuditedAction", () => {
  it("records the audit with the signer resolved server-side and revalidates", async () => {
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }));
    expect(res).toEqual({ ok: true });
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", "admin-1");
    expect(recordAudit).toHaveBeenCalledWith({
      itemId: "i1",
      auditedById: "admin-1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/i/i1");
    expect(revalidatePath).toHaveBeenCalledWith("/items");
  });

  it("rejects a retired item without recording", async () => {
    getItem.mockResolvedValueOnce({ id: "i1", status: "RETIRED" });
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejects a signature the admin does not own", async () => {
    getOwnedSignature.mockResolvedValueOnce(null);
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-x" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejects missing input", async () => {
    const res = await markAuditedAction(undefined, fd({ itemId: "i1" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("propagates the auth guard (non-admin cannot record)", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }))).rejects.toThrow();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/admin/actions/audit.test.ts`
Expected: FAIL — cannot find module `./audit`.

- [ ] **Step 3: Write the implementation**

Create `src/app/admin/actions/audit.ts`:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
import { recordAudit } from "@/modules/audit/audit.service";

const schema = z.object({
  itemId: z.string().min(1),
  signatureId: z.string().min(1),
});

// Mark an item as audited from the item detail page. Admin-only. The client posts
// only `signatureId`; the signer name + image are re-read server-side scoped to the
// acting admin, so a client cannot forge a signer or use another admin's signature.
export async function markAuditedAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  const user = await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid input." };
  const { itemId, signatureId } = parsed.data;
  try {
    const item = await getItem(itemId);
    if (!item) return { error: "Item not found." };
    // Backend validation matching the hidden UI: retired items are out of service.
    if (item.status === "RETIRED") return { error: "Retired items cannot be audited." };
    const sig = await getOwnedSignature(signatureId, user.id);
    if (!sig) return { error: "Select a valid signature." };
    await recordAudit({
      itemId,
      auditedById: user.id,
      auditedByName: user.name,
      signerName: sig.name,
      signatureImage: sig.image,
    });
  } catch (e) {
    console.error("[markAuditedAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath(`/i/${itemId}`);
  revalidatePath("/items");
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/admin/actions/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/actions/audit.ts src/app/admin/actions/audit.test.ts
git commit -m "feat(audit): add markAuditedAction server action"
```

---

### Task 5: `AuditLight` component + CSS

**Files:**
- Create: `src/components/AuditLight.tsx`
- Modify: `src/app/globals.css` (append after the `.badge-*` rules, ~line 810)

**Interfaces:**
- Consumes: `auditStateDisplay`, `AuditState` (`@/modules/audit/audit.status`).
- Produces: `AuditLight({ state }: { state: AuditState | null })` — renders a colored dot with an accessible label, or a dash when `state` is null (retired / not applicable).

- [ ] **Step 1: Create the component**

Create `src/components/AuditLight.tsx`:

```tsx
import { auditStateDisplay, type AuditState } from "@/modules/audit/audit.status";

// A colored dot for an item's audit status. `null` means not applicable (e.g. a
// retired item) and renders a neutral dash. The label is exposed via aria-label +
// title so the signal is never color-only.
export function AuditLight({ state }: { state: AuditState | null }) {
  if (!state) return <span className="subtle">—</span>;
  const { label, className } = auditStateDisplay(state);
  return (
    <span
      className={`audit-dot ${className}`}
      role="img"
      aria-label={`Audit: ${label}`}
      title={`Audit: ${label}`}
    />
  );
}
```

- [ ] **Step 2: Add the dot styles to `globals.css`**

Append after the `.badge-override` rule (reuses the existing `--green` / `--amber` / `--slate` color tokens):

```css
.audit-dot {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  vertical-align: middle;
}
.audit-dot--compliant { background: var(--green); }
.audit-dot--overdue { background: var(--amber); }
.audit-dot--never { background: var(--slate); }

.alert-warning {
  background: var(--amber-soft);
  border: 1px solid var(--amber-border);
  color: var(--amber);
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 14px;
}
```

- [ ] **Step 3: Type-check the new component**

Run: `npx tsc --noEmit`
Expected: no errors introduced by `AuditLight.tsx` (pre-existing unrelated output, if any, unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/components/AuditLight.tsx src/app/globals.css
git commit -m "feat(audit): add AuditLight dot component and styles"
```

---

### Task 6: Items list — audit column

**Files:**
- Modify: `src/components/items-view.ts` (SortField line 5, ItemRow lines 7-14, ITEM_COLUMNS lines 18-24)
- Modify: `src/components/ItemSelectTable.tsx` (import ~line 5, body row ~line 159)
- Modify: `src/app/items/page.tsx` (imports lines 1-5, body lines 11 + 37-40)

**Interfaces:**
- Consumes: `AuditState`, `auditState` (`@/modules/audit/audit.status`), `getLatestAuditMap` (`@/modules/audit/audit.service`), `AuditLight` (`@/components/AuditLight`).
- Produces: `ItemRow` gains `auditState: AuditState | null`; column key `"auditState"` added to `SortField` and `ITEM_COLUMNS`.

- [ ] **Step 1: Extend the row model and columns in `items-view.ts`**

At the top of the file, add the import:

```ts
import type { AuditState } from "@/modules/audit/audit.status";
```

Change `SortField` (line 5) to include the new key:

```ts
export type SortField = "deviceName" | "make" | "model" | "serialNumber" | "status" | "auditState";
```

Add to `ItemRow` (after `status`):

```ts
  auditState: AuditState | null;
```

Add to `ITEM_COLUMNS` (after the `status` entry):

```ts
  { key: "auditState", label: "Audit" },
```

- [ ] **Step 2: Render the column cell in `ItemSelectTable.tsx`**

Add the import near the other component imports (after the `StatusBadge` import, ~line 5):

```tsx
import { AuditLight } from "@/components/AuditLight";
```

In the table body, add the audit cell immediately after the `status` cell (the line rendering `{!isHidden("status") && ...}`, ~line 159), before the actions `<td>`:

```tsx
                {!isHidden("auditState") && <td data-label="Audit"><AuditLight state={it.auditState} /></td>}
```

(The header cell renders automatically from `ITEM_COLUMNS` via `visibleCols.map`. Sorting by this column groups rows by state string; retired rows carry `null`, which `sortRows` sorts last.)

- [ ] **Step 3: Supply `auditState` from the items page**

In `src/app/items/page.tsx`, add imports:

```tsx
import { getLatestAuditMap } from "@/modules/audit/audit.service";
import { auditState } from "@/modules/audit/audit.status";
```

After `const items = await listItems({ search: q });` (line 11), add:

```tsx
  const auditMap = await getLatestAuditMap(items.map((i) => i.id));
  const now = new Date();
```

Update the `items={items.map(...)}` prop (lines 37-40) to include `auditState` (retired items get `null` so they render a dash):

```tsx
            items={items.map((it) => ({
              id: it.id,
              deviceName: it.deviceName,
              make: it.make,
              model: it.model,
              serialNumber: it.serialNumber,
              status: it.status,
              auditState: it.status === "RETIRED" ? null : auditState(auditMap.get(it.id) ?? null, now),
            }))}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (every `ItemRow` construction now supplies `auditState`).

- [ ] **Step 5: Verify in a real browser**

Run `npm run dev`, sign in, open `/items`. Confirm: an "Audit" column shows a gray dot for never-audited items, the Columns menu can hide it, and the sort dropdown lists "Audit". (jsdom has no layout engine, so a browser is the only valid check for the rendered light.)

- [ ] **Step 6: Commit**

```bash
git add src/components/items-view.ts src/components/ItemSelectTable.tsx src/app/items/page.tsx
git commit -m "feat(audit): show audit light column on the items list"
```

---

### Task 7: Item detail page — Audit card, controls, and history

**Files:**
- Create: `src/app/i/[itemId]/AuditControls.tsx`
- Modify: `src/app/i/[itemId]/page.tsx` (imports lines 1-16, fetch block lines 21-34, add the card after the Service card ~line 120)

**Interfaces:**
- Consumes: `markAuditedAction` (`@/app/admin/actions/audit`), `PickableSignature` (`@/components/TechnicianSignatureField`), `getAuditsForItem` (`@/modules/audit/audit.service`), `listSignatures` (`@/modules/signatures/signatures.service`), `auditState`/`auditStateDisplay` (`@/modules/audit/audit.status`), `AuditLight` (`@/components/AuditLight`), `formatDateTimeHST` (`@/lib/datetime`).
- Produces: `AuditControls({ itemId, signatures }: { itemId: string; signatures: PickableSignature[] })`.

- [ ] **Step 1: Create the admin control component**

Create `src/app/i/[itemId]/AuditControls.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { markAuditedAction } from "@/app/admin/actions/audit";
import type { PickableSignature } from "@/components/TechnicianSignatureField";

// Admin-only control on the item detail Audit card: pick a saved signature and mark
// the item audited. Posts only `signatureId` — the server re-reads the signer name
// and image scoped to the acting admin.
export function AuditControls({ itemId, signatures }: { itemId: string; signatures: PickableSignature[] }) {
  const [state, action, pending] = useActionState(markAuditedAction, undefined);

  if (signatures.length === 0) {
    return (
      <p className="subtle">
        Add a signature in your <a href="/account">account settings</a> to mark items as audited.
      </p>
    );
  }

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Signature</span>
          <select className="select" style={{ width: "auto", minWidth: 180 }} name="signatureId" defaultValue="" required>
            <option value="" disabled>— Select who audited —</option>
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={pending} type="submit">
          {pending ? "Saving…" : "Mark as audited"}
        </button>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      {state?.ok && <p className="alert-success">Marked as audited.</p>}
    </form>
  );
}
```

- [ ] **Step 2: Wire fetches into the detail page**

In `src/app/i/[itemId]/page.tsx`, add imports:

```tsx
import { getAuditsForItem } from "@/modules/audit/audit.service";
import { listSignatures } from "@/modules/signatures/signatures.service";
import { auditState, auditStateDisplay } from "@/modules/audit/audit.status";
import { AuditLight } from "@/components/AuditLight";
import { AuditControls } from "./AuditControls";
```

Add `getAuditsForItem(itemId)` to the `Promise.all` array (it depends only on `itemId`), capturing it as `audits`. The destructuring becomes:

```tsx
  const [item, user, receipts, currentHolder, qr, service, units, lastEdit, audits] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    getHoldingTransfer(itemId),
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
    getServiceRequestForItem(itemId),
    listUnits(),
    prisma.itemEdit.findFirst({ where: { itemId }, orderBy: { createdAt: "desc" } }),
    getAuditsForItem(itemId),
  ]);
```

After `const isAdmin = user?.role === "ADMIN";`, add (signatures need `user.id`, so they load after the batch and only for an admin auditing an active item):

```tsx
  const signatures = isAdmin && item.status === "ACTIVE" ? await listSignatures(user!.id) : [];
  const now = new Date();
  const auditLightState = item.status === "RETIRED" ? null : auditState(audits[0]?.createdAt ?? null, now);
```

- [ ] **Step 3: Add the overdue banner**

In `src/app/i/[itemId]/page.tsx`, add this block immediately after the title `<div className="row">…<StatusBadge /></div>` block (near the top of `<main>`, before the "Create hand receipt" block). It shows only for overdue items — `auditLightState` is `"overdue"` only for an ACTIVE item past its 1-year mark (retired is `null`, never-audited is `"never"`, compliant is `"compliant"`):

```tsx
        {auditLightState === "overdue" && (
          <div role="alert" className="alert-warning">
            This item is overdue for its annual audit.
          </div>
        )}
```

- [ ] **Step 4: Add the Audit card**

In `src/app/i/[itemId]/page.tsx`, add this block immediately after the Service card's closing `)}` (the `{loggedIn && (...)}` block ending ~line 120), before the QR card:

```tsx
        {loggedIn && (
          <div className="card">
            <div className="card__title">Audit</div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <AuditLight state={auditLightState} />
              <span>
                {item.status === "RETIRED"
                  ? "Not applicable (retired)"
                  : audits.length === 0
                  ? "Never audited"
                  : `${auditStateDisplay(auditState(audits[0].createdAt, now)).label} · last audited ${formatDateTimeHST(audits[0].createdAt)} by ${audits[0].signerName}`}
              </span>
            </div>

            {isAdmin && item.status === "ACTIVE" && <AuditControls itemId={item.id} signatures={signatures} />}

            {audits.length > 0 && (
              <div className="stack-sm">
                <div className="subtle" style={{ fontSize: 12 }}>Audit history</div>
                <ul className="stack-sm">
                  {audits.map((a) => (
                    <li key={a.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.signatureImage} alt={`Signature of ${a.signerName}`} className="sig-preview" />
                      <span>{a.signerName} · {formatDateTimeHST(a.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Verify end-to-end in a real browser**

Run `npm run dev`. As an admin with at least one saved signature (create one at `/account` if needed):
1. Open an active item at `/i/<itemId>`. Confirm the Audit card shows a gray dot + "Never audited", and **no** overdue banner appears (never-audited is not overdue).
2. Pick a signature, click "Mark as audited". Confirm success, the light turns green, the status line shows the date + signer, and the audit history lists the entry with the signature thumbnail.
3. Reload `/items` — the item's audit light is now green.
4. As a non-admin, confirm the Audit card shows the light + status but no mark-audited control.
5. Retire the item; confirm `/items` shows a dash and the detail card shows "Not applicable (retired)" with no control and no banner.
6. (Overdue banner) To see the amber banner, backdate an audit row to >1 year ago via a DB client (e.g. `UPDATE "ItemAudit" SET "createdAt" = NOW() - INTERVAL '2 years' WHERE "itemId" = '<itemId>';`), reload the active item page, and confirm the amber "overdue for its annual audit" banner shows near the top and the light is yellow.

- [ ] **Step 7: Run linters and the audit test files**

Run:
```bash
npm run lint
npx vitest run src/modules/audit src/app/admin/actions/audit.test.ts
```
Expected: lint clean; all audit tests pass.

- [ ] **Step 8: Commit**

```bash
git add "src/app/i/[itemId]/AuditControls.tsx" "src/app/i/[itemId]/page.tsx"
git commit -m "feat(audit): add audit card, mark-audited control, and history to item page"
```

---

## Self-Review Notes

- **Spec coverage:** status field on both views (Tasks 6, 7), green/yellow lights + distinct never state (Tasks 2, 5), yellow after 1 year (Task 2), admin mark-audited with date + signature logged (Tasks 3, 4, 7), full history (Tasks 1, 3, 7), retired-item exclusion (Tasks 4, 6, 7), all-logged-in visibility vs admin-only marking (Task 7), overdue-only detail-page banner (Task 7 Step 3 + `.alert-warning` in Task 5). All covered.
- **Type consistency:** `auditState`/`AuditState`/`auditStateDisplay` (Task 2) are consumed unchanged in Tasks 5–7; `RecordAuditInput`/`recordAudit`/`getAuditsForItem`/`getLatestAuditMap` (Task 3) match their uses in Tasks 4, 6, 7; the column key `"auditState"` matches the `ItemRow.auditState` property so `sortRows` sorts correctly.
- **Retired sentinel:** `ItemRow.auditState` is `AuditState | null`; `null` (retired) renders a dash and sorts last — a single rule used identically by the list and the detail card.
