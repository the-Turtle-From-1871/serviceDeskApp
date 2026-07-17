# Hand-Receipt & Service-Desk Timers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional return-by timer to hand receipts and a per-service-type SLA timer to service-queue items, emailing the shared admin inbox once when a timer lapses, and surfacing overdue/due-soon work on a new `/admin` dashboard plus the service queue.

**Architecture:** Reuse the existing "compute a deadline timestamp → index it → sweep it from the daily cron" pattern (`purgeAfter` / `purgeExpiredTransfers`). Two nullable columns (`dueAt`, `overdueAlertedAt`) on `Transfer` and `ServiceQueueItem`; a shared pure `due.ts` helper for day math + badge state; two `server-only` alert-sweep services wired into the existing `/api/cron/purge` route; a new dashboard page and a Due column on the queue.

**Tech Stack:** Next.js 16 (App Router, RSC), React 19, TypeScript 5, Prisma 7 + `@prisma/adapter-pg`, PostgreSQL, Zod, Vitest (Node env, `fileParallelism: false`, shared test DB), nodemailer/Resend via `getEmailSender()`.

## Global Constraints

- **Next.js is NOT stock:** before writing App-Router/Server-Action code, consult `node_modules/next/dist/docs/` — APIs may differ from training data (see `AGENTS.md`).
- **Access control on every server action:** start admin actions with `await requireAdmin()`; never trust input IDs — scope Prisma queries so ownership/state is verified server-side.
- **Immutable closed receipts:** a `CLOSED` transfer cannot be edited — guard mutations with `assertTransferOpen(t)`.
- **Injection:** use standard Prisma methods only; no string-interpolated raw SQL; no `dangerouslySetInnerHTML`.
- **Secrets/config:** admin inbox comes from `process.env.ADMIN_INBOX_EMAIL` (never hardcode `dcsimservicedesk@gmail.com`). Cron stays behind `CRON_SECRET`.
- **Server-only leakage:** every module that touches Prisma for a worker/sweep starts with `import "server-only"`.
- **Error handling:** catch in actions, return generic client messages (`"Something went wrong"`), `console.error` details server-side.
- **Supply chain:** no new npm packages are required; do not add any.
- **Migrations:** `prisma migrate dev` cannot run in this shell. Author SQL via `prisma migrate diff … --script`, save under `prisma/migrations/`, apply with `npx prisma migrate deploy`, then `npx prisma generate`. Prod is applied manually via the Supabase MCP later (out of scope for this plan).
- **Tests:** DB-service tests in this repo mock `@/lib/prisma` (see `transfers.service.test.ts`); pure logic is tested directly (see `lifecycle.test.ts`). Follow those two styles. Run with `npx vitest run <path>`. jsdom/`npm run build` are NOT visual proof — CSS/mobile changes are verified in a real browser.
- **Time zone:** deadlines are stored as UTC instants; day math is whole 24h days. Display uses the existing `formatDateTimeHST` helper.

---

## File structure

**New files:**
- `src/modules/timers/due.ts` — pure: `computeDueAt`, `DUE_SOON_DAYS`, `dueState`, types. Shared by both domains + UI.
- `src/modules/timers/due.test.ts`
- `src/modules/service-queue/sla.ts` — `SLA_DAYS`, `computeServiceDueAt`.
- `src/modules/service-queue/sla.test.ts`
- `src/modules/transfers/timer-alert.service.ts` — `sendOverdueTransferAlerts(now, deps?)` (server-only).
- `src/modules/transfers/timer-alert.service.test.ts`
- `src/modules/service-queue/timer-alert.service.ts` — `sendOverdueServiceAlerts(now, deps?)` (server-only).
- `src/modules/service-queue/timer-alert.service.test.ts`
- `src/app/admin/actions/receipt-timer.ts` — `setReceiptDueAtAction`.
- `src/app/admin/actions/receipt-timer.test.ts`
- `src/app/admin/dashboard/dashboard.service.ts` — server-only dashboard queries.
- `src/components/DueBadge.tsx` — presentational badge (client-free; pure render).
- `prisma/migrations/<timestamp>_add_timers/migration.sql`

**Modified files:**
- `prisma/schema.prisma` — new columns + indexes on `Transfer` and `ServiceQueueItem`.
- `src/modules/transfers/transfers.service.ts` — `CreateInput.dueAt`; `setTransferDueAt`; `listOpenTransfersWithTimers`.
- `src/modules/transfers/transfers.schema.ts` — `returnDays` on `receiptSchema`.
- `src/app/actions/receipts.parse.ts` — parse `returnDays`.
- `src/app/actions/receipts.ts` — compute + pass `dueAt`; pass per-item `overrideDays`.
- `src/modules/service-queue/service-queue.service.ts` — `UpsertInput.overrideDays`; stamp `dueAt`; reset `overdueAlertedAt`; `listPendingServiceWithTimers`; add `dueAt` to `queue*Select` payloads.
- `src/modules/service-queue/service-form.ts` — `ServiceSelection.overrideDays`; parse `service[<id>][days]`.
- `src/app/admin/actions/queue.ts` — thread `overrideDays` through `setServiceAction`.
- `src/components/service-queue-view.ts` — `dueAt` on `QueueRowVM`; `due` sort field + column; sort/filter support.
- `src/components/ServiceQueueTable.tsx` — render Due column.
- `src/app/admin/queue/page.tsx` — map `dueAt` into the VM.
- `src/app/admin/page.tsx` — replace redirect with the dashboard.
- `src/app/receipts/[receiptNumber]/page.tsx` — show due state + admin edit control.
- `src/app/receipts/new/ReceiptBuilderForm.tsx` — "Return by" control + per-item override field.
- `src/app/i/[itemId]/page.tsx` — per-item service override field + due display (follow the file's existing service-flag block).

**Spec deviation (intentional):** the spec's "receipts list badge column" has no target — no admin receipts-list page exists (receipts are reached by search/number). Hand-receipt timers therefore surface on the dashboard card + the receipt detail page instead. No other spec change.

---

## Task 1: Schema — timer columns + indexes

**Files:**
- Modify: `prisma/schema.prisma` (`Transfer` model ~113-154; `ServiceQueueItem` model ~235-249)
- Create: `prisma/migrations/<timestamp>_add_timers/migration.sql`

**Interfaces:**
- Produces: `Transfer.dueAt: DateTime?`, `Transfer.overdueAlertedAt: DateTime?`, `ServiceQueueItem.dueAt: DateTime?`, `ServiceQueueItem.overdueAlertedAt: DateTime?` on the generated Prisma client.

- [ ] **Step 1: Add fields + indexes to `Transfer`**

In `prisma/schema.prisma`, inside `model Transfer`, add after the `purgeAfter DateTime?` line (keep the existing `@@index([purgeAfter])`):

```prisma
  // Return timer: optional deadline for the borrower to bring items back. Null =
  // no timer. `overdueAlertedAt` is stamped when the single overdue email fires,
  // so the cron sweep never emails the same lapsed receipt twice; editing the
  // deadline to a new future date clears it so the fresh deadline can alert.
  dueAt            DateTime?
  overdueAlertedAt DateTime?
```

And add this index alongside `@@index([purgeAfter])`:

```prisma
  @@index([dueAt])
```

- [ ] **Step 2: Add fields + index to `ServiceQueueItem`**

Inside `model ServiceQueueItem`, add after `updatedAt DateTime @updatedAt`:

```prisma
  // Completion SLA timer. dueAt defaults from the service type (see sla.ts) when
  // the item is flagged, overridable per item. Null = no timer. overdueAlertedAt
  // mirrors Transfer's — one alert per lapse, reset when the item is re-flagged.
  dueAt            DateTime?
  overdueAlertedAt DateTime?
```

And add alongside the existing indexes:

```prisma
  @@index([dueAt])
```

- [ ] **Step 3: Generate the migration SQL**

Run (per project memory — `migrate dev` can't run here; Prisma 7 flag names):

```bash
mkdir -p "prisma/migrations/$(node -e "process.stdout.write(new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14))")_add_timers"
npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script
```

Expected output (save it as the new folder's `migration.sql`; if the diff tool is unavailable, hand-write exactly this):

```sql
ALTER TABLE "Transfer" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "Transfer" ADD COLUMN "overdueAlertedAt" TIMESTAMP(3);
ALTER TABLE "ServiceQueueItem" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "ServiceQueueItem" ADD COLUMN "overdueAlertedAt" TIMESTAMP(3);
CREATE INDEX "Transfer_dueAt_idx" ON "Transfer"("dueAt");
CREATE INDEX "ServiceQueueItem_dueAt_idx" ON "ServiceQueueItem"("dueAt");
```

- [ ] **Step 4: Apply to the local/test DB and regenerate the client**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: migrate deploy reports the new migration applied; generate reports the client rebuilt with no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(timers): add dueAt/overdueAlertedAt columns to Transfer and ServiceQueueItem"
```

---

## Task 2: Shared due-date logic (`due.ts`)

**Files:**
- Create: `src/modules/timers/due.ts`
- Test: `src/modules/timers/due.test.ts`

**Interfaces:**
- Produces:
  - `computeDueAt(from: Date, days: number): Date`
  - `DUE_SOON_DAYS = 3`
  - `type DueState = { state: "none" | "ontrack" | "soon" | "overdue"; days: number }` — `days` = whole days until due (negative = days overdue); `0` when `dueAt` is null and state `"none"`.
  - `dueState(dueAt: Date | null, now?: Date): DueState`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeDueAt, dueState, DUE_SOON_DAYS } from "./due";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe("computeDueAt", () => {
  it("adds whole days without mutating the input", () => {
    expect(computeDueAt(NOW, 30).toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(NOW.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });
});

describe("dueState", () => {
  it("is 'none' with 0 days when there is no timer", () => {
    expect(dueState(null, NOW)).toEqual({ state: "none", days: 0 });
  });
  it("is 'overdue' with negative days once the deadline has passed", () => {
    expect(dueState(day(-2), NOW)).toEqual({ state: "overdue", days: -2 });
  });
  it("is 'overdue' exactly at the boundary", () => {
    expect(dueState(new Date(NOW), NOW)).toMatchObject({ state: "overdue" });
  });
  it("is 'soon' within the due-soon window", () => {
    expect(dueState(day(DUE_SOON_DAYS), NOW)).toMatchObject({ state: "soon", days: DUE_SOON_DAYS });
  });
  it("is 'ontrack' beyond the due-soon window", () => {
    expect(dueState(day(10), NOW)).toEqual({ state: "ontrack", days: 10 });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './due'`).

```bash
npx vitest run src/modules/timers/due.test.ts
```

- [ ] **Step 3: Implement `src/modules/timers/due.ts`**

```ts
// Pure timer math shared by hand receipts, the service queue, and the UI. No
// Prisma/`server-only` here so it is unit-testable and safe in client bundles.
const DAY_MS = 24 * 60 * 60 * 1000;

export const DUE_SOON_DAYS = 3;

export type DueStateName = "none" | "ontrack" | "soon" | "overdue";
export type DueState = { state: DueStateName; days: number };

/** A deadline `days` whole days after `from`. Does not mutate `from`. */
export function computeDueAt(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Classify a deadline relative to `now`. `days` is whole days until due
 *  (negative = overdue). Overdue includes the exact boundary (now >= dueAt),
 *  matching isPurgeEligible. */
export function dueState(dueAt: Date | null, now: Date = new Date()): DueState {
  if (!dueAt) return { state: "none", days: 0 };
  const diffMs = dueAt.getTime() - now.getTime();
  const days = Math.trunc(diffMs / DAY_MS);
  if (diffMs <= 0) return { state: "overdue", days };
  if (days <= DUE_SOON_DAYS) return { state: "soon", days };
  return { state: "ontrack", days };
}
```

Note: `day(DUE_SOON_DAYS)` in the test is exactly `now + 3d`, `diffMs > 0`, `days === 3 <= 3` → `soon`. Good.

- [ ] **Step 4: Run it — expect PASS.**

```bash
npx vitest run src/modules/timers/due.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/timers/due.ts src/modules/timers/due.test.ts
git commit -m "feat(timers): add shared due-date math and state helper"
```

---

## Task 3: Service SLA defaults (`sla.ts`)

**Files:**
- Create: `src/modules/service-queue/sla.ts`
- Test: `src/modules/service-queue/sla.test.ts`

**Interfaces:**
- Consumes: `computeDueAt` from `@/modules/timers/due`.
- Produces:
  - `SLA_DAYS: Record<ServiceType, number>` = `{ REIMAGE: 3, REPAIR: 7, OTHER: 5 }`
  - `computeServiceDueAt(type: ServiceType, from: Date, overrideDays?: number | null): Date`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { SLA_DAYS, computeServiceDueAt } from "./sla";

const FROM = new Date("2026-07-17T00:00:00.000Z");
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));

describe("SLA_DAYS", () => {
  it("has the agreed per-type defaults", () => {
    expect(SLA_DAYS).toEqual({ REIMAGE: 3, REPAIR: 7, OTHER: 5 });
  });
});

describe("computeServiceDueAt", () => {
  it("uses the type default when no override is given", () => {
    expect(daysBetween(computeServiceDueAt("REPAIR", FROM), FROM)).toBe(7);
  });
  it("uses the override when provided", () => {
    expect(daysBetween(computeServiceDueAt("REPAIR", FROM, 2), FROM)).toBe(2);
  });
  it("ignores a null override and falls back to the default", () => {
    expect(daysBetween(computeServiceDueAt("REIMAGE", FROM, null), FROM)).toBe(3);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
npx vitest run src/modules/service-queue/sla.test.ts
```

- [ ] **Step 3: Implement `src/modules/service-queue/sla.ts`**

```ts
import type { ServiceType } from "@prisma/client";
import { computeDueAt } from "@/modules/timers/due";

// Default completion SLA per service type (whole days from when the item is
// flagged). Overridable per item on the flag UI.
export const SLA_DAYS: Record<ServiceType, number> = { REIMAGE: 3, REPAIR: 7, OTHER: 5 };

/** The completion deadline for a service item: `from` + (override or type default) days. */
export function computeServiceDueAt(type: ServiceType, from: Date, overrideDays?: number | null): Date {
  const days = overrideDays != null ? overrideDays : SLA_DAYS[type];
  return computeDueAt(from, days);
}
```

- [ ] **Step 4: Run it — expect PASS.**

```bash
npx vitest run src/modules/service-queue/sla.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/service-queue/sla.ts src/modules/service-queue/sla.test.ts
git commit -m "feat(timers): add per-service-type SLA defaults and deadline helper"
```

---

## Task 4: Stamp `dueAt` when a hand receipt is created

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts` (`CreateInput` ~9-16; `tx.transfer.create` data ~45-79)
- Modify: `src/modules/transfers/transfers.schema.ts` (`receiptSchema` ~53-68)
- Modify: `src/app/actions/receipts.parse.ts` (`parseReceiptForm` return ~27)
- Modify: `src/app/actions/receipts.ts` (`createTransfer` call ~74)
- Test: `src/modules/transfers/transfers.service.test.ts` (add a case; existing mock already returns `created`)

**Interfaces:**
- Consumes: `dueState`/`computeDueAt` not needed here (the action computes the Date).
- Produces:
  - `CreateInput.dueAt?: Date | null` on `createTransfer`.
  - `receiptSchema` gains `returnDays?: number` (coerced positive int, ≤ 3650).
  - `parseReceiptForm(...)` return gains `returnDays: string` (raw).

- [ ] **Step 1: Write the failing test** (append to `transfers.service.test.ts` inside the existing `describe`)

```ts
  it("stamps dueAt on the created transfer when provided", async () => {
    const due = new Date("2026-08-16T00:00:00.000Z");
    await createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig, dueAt: due });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(data.dueAt).toBe(due);
  });

  it("leaves dueAt null when omitted", async () => {
    await createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(data.dueAt ?? null).toBeNull();
  });
```

- [ ] **Step 2: Run it — expect FAIL** (`dueAt` not in create data).

```bash
npx vitest run src/modules/transfers/transfers.service.test.ts
```

- [ ] **Step 3: Implement**

In `transfers.service.ts`, add to `CreateInput`:

```ts
  createdByUserId?: string;
  dueAt?: Date | null;
```

Destructure it and set it in the create data (add a line next to `createdByUserId`):

```ts
  const { itemIds, lines: lineQtys, sender, receiver, receiverSignature, createdByUserId, dueAt } = input;
```

```ts
        createdByUserId: createdByUserId ?? null,
        dueAt: dueAt ?? null,
        status: "OPEN",
```

In `transfers.schema.ts`, add to the `receiptSchema` object (before the `.superRefine`):

```ts
    returnDays: z.coerce.number().int().positive().max(3650).optional(),
```

In `receipts.parse.ts`, add `returnDays` to the returned object:

```ts
  return { itemIds, lines, sender: party(fd, "sender"), receiver: party(fd, "receiver"), receiverSignature: String(fd.get("receiverSignature") ?? ""), returnDays: s(fd, "returnDays") };
```

In `receipts.ts`, import the helper and compute `dueAt` from the parsed days at the `createTransfer` call:

```ts
import { computeDueAt } from "@/modules/timers/due";
```

```ts
    const dueAt = parsed.data.returnDays ? computeDueAt(new Date(), parsed.data.returnDays) : null;
    const t = await createTransfer({ ...parsed.data, createdByUserId: user.id, dueAt });
```

(`...parsed.data` carries `returnDays`, which `createTransfer` ignores — harmless. `dueAt` after the spread wins.)

- [ ] **Step 4: Run it — expect PASS.** Also run the schema test to confirm no regression:

```bash
npx vitest run src/modules/transfers/transfers.service.test.ts src/modules/transfers/transfers.schema.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/transfers.service.ts src/modules/transfers/transfers.schema.ts src/app/actions/receipts.parse.ts src/app/actions/receipts.ts
git commit -m "feat(timers): set hand-receipt dueAt from a return-by days input"
```

---

## Task 5: Stamp `dueAt` when a service item is flagged

**Files:**
- Modify: `src/modules/service-queue/service-queue.service.ts` (`UpsertInput` ~19; `upsertServiceRequest` ~31-39; `queueItemSelect`/selects ~7-8; `QueueRow` ~10-13)
- Modify: `src/modules/service-queue/service-form.ts` (`ServiceSelection` ~3; `parseServiceMap` ~19-40)
- Modify: `src/app/admin/actions/queue.ts` (`setSchema` ~15-19; `setServiceAction` ~28-44; `createReceiptAction` already passes note/type — extend in Task 4's file? No: builder path is `receipts.ts`)
- Modify: `src/app/actions/receipts.ts` (`upsertServiceRequest` call ~83 — pass `overrideDays`)
- Test: `src/modules/service-queue/service-queue.service.test.ts`; `src/modules/service-queue/service-form.test.ts`

**Interfaces:**
- Consumes: `computeServiceDueAt` from `./sla`.
- Produces:
  - `UpsertInput.overrideDays?: number | null`; `upsertServiceRequest` stamps `dueAt` (create + update) and resets `overdueAlertedAt: null` on update.
  - `ServiceSelection.overrideDays: number | null`; `parseServiceMap` reads `service[<id>][days]`.
  - `setSchema` accepts `overrideDays` (optional coerced positive int).

- [ ] **Step 1: Write the failing tests**

Append to `service-queue.service.test.ts` `describe("upsertServiceRequest")` — note the mock's `upsert` is called with the built args:

```ts
  it("stamps dueAt from the type default and resets overdueAlertedAt on update", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.create.dueAt).toBeInstanceOf(Date);
    expect(arg.update.dueAt).toBeInstanceOf(Date);
    expect(arg.update.overdueAlertedAt).toBeNull();
    expect(arg.create.overdueAlertedAt ?? null).toBeNull();
  });

  it("honors an override days value for dueAt", async () => {
    const before = Date.now();
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 1 });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    const days = Math.round((arg.create.dueAt.getTime() - before) / (24 * 60 * 60 * 1000));
    expect(days).toBe(1);
  });
```

Append to `service-form.test.ts` a case that a `days` field is parsed (mirror the file's existing FormData-building style):

```ts
  it("captures a per-item override days value", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REPAIR");
    fd.set("service[i1][days]", "2");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays).toBe(2);
  });

  it("leaves overrideDays null when the days field is absent or blank", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REIMAGE");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays ?? null).toBeNull();
  });
```

- [ ] **Step 2: Run them — expect FAIL.**

```bash
npx vitest run src/modules/service-queue/service-queue.service.test.ts src/modules/service-queue/service-form.test.ts
```

- [ ] **Step 3: Implement**

In `service-form.ts`, extend the type and the regex/parse:

```ts
export type ServiceSelection = { serviceType: ServiceType; note: string | null; overrideDays: number | null };
```

```ts
const FIELD_RE = /^service\[([^\]]+)\]\[(needs|type|note|days)\]$/;
```

In the accumulation loop add a `days` branch, and in the result loop parse it:

```ts
    if (field === "needs") row.needs = value === "on" || value === "true";
    else if (field === "type") row.type = String(value);
    else if (field === "days") row.days = String(value);
    else row.note = String(value);
```

(Widen the `rows` value type to include `days?: string`.) Then:

```ts
    const note = serviceType === "OTHER" ? (row.note ?? "").trim() || null : null;
    const n = Number.parseInt((row.days ?? "").trim(), 10);
    const overrideDays = Number.isInteger(n) && n > 0 ? n : null;
    result.set(itemId, { serviceType, note, overrideDays });
```

In `service-queue.service.ts`:

```ts
import { computeServiceDueAt } from "./sla";
```

Extend `UpsertInput` and `upsertServiceRequest`:

```ts
type UpsertInput = { itemId: string; serviceType: ServiceType; note?: string | null; transferId?: string | null; overrideDays?: number | null };
```

```ts
export async function upsertServiceRequest(input: UpsertInput): Promise<ServiceQueueItem> {
  const serviceNote = normalizeNote(input.serviceType, input.note);
  const transferId = input.transferId ?? null;
  const dueAt = computeServiceDueAt(input.serviceType, new Date(), input.overrideDays);
  return prisma.serviceQueueItem.upsert({
    where: { itemId: input.itemId },
    create: { itemId: input.itemId, serviceType: input.serviceType, serviceNote, transferId, status: "PENDING", dueAt, overdueAlertedAt: null },
    update: { serviceType: input.serviceType, serviceNote, transferId, status: "PENDING", dueAt, overdueAlertedAt: null },
  });
}
```

In `queue.ts`, add `overrideDays` to `setSchema` and thread it (Zod coerces the string form field):

```ts
const setSchema = z.object({
  itemId: z.string().min(1),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: z.string().optional(),
  overrideDays: z.coerce.number().int().positive().max(3650).optional(),
});
```

`setServiceAction` already spreads `parsed.data` into `upsertServiceRequest({ ...parsed.data, transferId })`, so `overrideDays` flows through automatically.

In `receipts.ts`, pass the builder's per-item override into the enqueue call:

```ts
        await upsertServiceRequest({ itemId, serviceType: sel.serviceType, note: sel.note, overrideDays: sel.overrideDays, transferId: t.id });
```

- [ ] **Step 4: Run them — expect PASS.** Also run the queue action + receipts action tests for regressions:

```bash
npx vitest run src/modules/service-queue src/app/admin/actions/queue.test.ts src/app/actions/receipts.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/service-queue/service-queue.service.ts src/modules/service-queue/service-form.ts src/app/admin/actions/queue.ts src/app/actions/receipts.ts src/modules/service-queue/service-queue.service.test.ts src/modules/service-queue/service-form.test.ts
git commit -m "feat(timers): stamp service-item dueAt from SLA defaults with per-item override"
```

---

## Task 6: Hand-receipt overdue alert sweep

**Files:**
- Create: `src/modules/transfers/timer-alert.service.ts`
- Test: `src/modules/transfers/timer-alert.service.test.ts`

**Interfaces:**
- Consumes: `getEmailSender`/`EmailSender` from `@/lib/email`; `prisma`.
- Produces: `sendOverdueTransferAlerts(now?: Date, deps?: { sender?: EmailSender }): Promise<{ alertedCount: number }>`.

Query: `status = "OPEN" AND dueAt <= now AND overdueAlertedAt = null`. One email to `ADMIN_INBOX_EMAIL` per receipt; on success stamp `overdueAlertedAt`. If `ADMIN_INBOX_EMAIL` is unset, do nothing (no stamp) so alerts aren't silently lost. Send failures are logged and leave `overdueAlertedAt` null (retry next run); `alertedCount` counts only stamped receipts.

- [ ] **Step 1: Write the failing test** (mock `@/lib/prisma`, style per `service-queue.service.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    transfer: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  },
}));

import prisma from "@/lib/prisma";
import { sendOverdueTransferAlerts } from "./timer-alert.service";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { process.env = { ...orig }; });

const NOW = new Date("2026-07-17T00:00:00.000Z");
const row = { id: "t1", receiptNumber: "HR-000001", itemSummary: "Dell Latitude (SN X)", dueAt: new Date("2026-07-10T00:00:00.000Z") };

describe("sendOverdueTransferAlerts", () => {
  it("emails the admin inbox once and stamps overdueAlertedAt", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(prisma.transfer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "OPEN", dueAt: { not: null, lte: NOW }, overdueAlertedAt: null },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@army.mil");
    expect(send.mock.calls[0][0].subject).toContain("HR-000001");
    expect(prisma.transfer.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { overdueAlertedAt: NOW } });
    expect(res.alertedCount).toBe(1);
  });

  it("does nothing when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(prisma.transfer.update).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });

  it("does not stamp when the send fails", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => { throw new Error("boom"); });
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(prisma.transfer.update).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
npx vitest run src/modules/transfers/timer-alert.service.test.ts
```

- [ ] **Step 3: Implement `src/modules/transfers/timer-alert.service.ts`**

```ts
import "server-only"; // sends mail + reads PII — never bundle to the client
import prisma from "@/lib/prisma";
import { getEmailSender, type EmailSender } from "@/lib/email";
import { dueState } from "@/modules/timers/due";

export type AlertResult = { alertedCount: number };

// Emails the shared admin inbox once for each OPEN hand receipt whose return
// timer has lapsed and that has not been alerted yet, then stamps
// overdueAlertedAt so it never re-alerts. A send failure leaves the stamp unset
// so the next daily run retries. No-op (nothing stamped) when the admin inbox
// is unconfigured, so an alert is never silently dropped.
export async function sendOverdueTransferAlerts(
  now: Date = new Date(),
  deps: { sender?: EmailSender } = {},
): Promise<AlertResult> {
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (!adminInbox) return { alertedCount: 0 };

  const overdue = await prisma.transfer.findMany({
    where: { status: "OPEN", dueAt: { not: null, lte: now }, overdueAlertedAt: null },
    select: { id: true, receiptNumber: true, itemSummary: true, dueAt: true },
  });
  if (overdue.length === 0) return { alertedCount: 0 };

  const sender = deps.sender ?? getEmailSender();
  let alertedCount = 0;
  for (const t of overdue) {
    const daysOverdue = Math.abs(dueState(t.dueAt, now).days);
    const subject = `OVERDUE: hand receipt ${t.receiptNumber}`;
    const text = [
      `Hand receipt ${t.receiptNumber} is past its return deadline (${daysOverdue} day(s) overdue).`,
      ``,
      `Items: ${t.itemSummary}`,
      ``,
      `Recover these devices promptly, then process the return to close the receipt.`,
    ].join("\n");
    try {
      await sender.send({ to: adminInbox, subject, text });
      await prisma.transfer.update({ where: { id: t.id }, data: { overdueAlertedAt: now } });
      alertedCount++;
    } catch (e) {
      console.error(`[transfer-timer-alert] failed to alert ${t.receiptNumber}:`, e);
    }
  }
  return { alertedCount };
}
```

- [ ] **Step 4: Run it — expect PASS.**

```bash
npx vitest run src/modules/transfers/timer-alert.service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/timer-alert.service.ts src/modules/transfers/timer-alert.service.test.ts
git commit -m "feat(timers): add overdue hand-receipt alert sweep"
```

---

## Task 7: Service-item overdue alert sweep

**Files:**
- Create: `src/modules/service-queue/timer-alert.service.ts`
- Test: `src/modules/service-queue/timer-alert.service.test.ts`

**Interfaces:**
- Produces: `sendOverdueServiceAlerts(now?: Date, deps?: { sender?: EmailSender }): Promise<{ alertedCount: number }>`.

Query: `status = "PENDING" AND dueAt <= now AND overdueAlertedAt = null`, including the item's SN/device/unit + service type for the body.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    serviceQueueItem: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  },
}));

import prisma from "@/lib/prisma";
import { sendOverdueServiceAlerts } from "./timer-alert.service";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { process.env = { ...orig }; });

const NOW = new Date("2026-07-17T00:00:00.000Z");
const row = {
  id: "sq1", serviceType: "REIMAGE", serviceNote: null, dueAt: new Date("2026-07-14T00:00:00.000Z"),
  item: { serialNumber: "SN9", deviceName: "LT-9", homeUnit: "A Co" },
};

describe("sendOverdueServiceAlerts", () => {
  it("emails the admin inbox once and stamps overdueAlertedAt", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.serviceQueueItem.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueServiceAlerts(NOW, { sender: { send } });
    expect(prisma.serviceQueueItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "PENDING", dueAt: { not: null, lte: NOW }, overdueAlertedAt: null },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@army.mil");
    expect(send.mock.calls[0][0].text).toContain("SN9");
    expect(prisma.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { overdueAlertedAt: NOW } });
    expect(res.alertedCount).toBe(1);
  });

  it("does nothing when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    vi.mocked(prisma.serviceQueueItem.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueServiceAlerts(NOW, { sender: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
npx vitest run src/modules/service-queue/timer-alert.service.test.ts
```

- [ ] **Step 3: Implement `src/modules/service-queue/timer-alert.service.ts`**

```ts
import "server-only";
import prisma from "@/lib/prisma";
import { getEmailSender, type EmailSender } from "@/lib/email";
import { dueState } from "@/modules/timers/due";
import { serviceTypeLabel } from "./service-queue.status";

export type AlertResult = { alertedCount: number };

// Emails the shared admin inbox once for each PENDING service item whose
// completion SLA has lapsed, then stamps overdueAlertedAt. Mirrors
// sendOverdueTransferAlerts (see that file for the retry/no-op rationale).
export async function sendOverdueServiceAlerts(
  now: Date = new Date(),
  deps: { sender?: EmailSender } = {},
): Promise<AlertResult> {
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (!adminInbox) return { alertedCount: 0 };

  const overdue = await prisma.serviceQueueItem.findMany({
    where: { status: "PENDING", dueAt: { not: null, lte: now }, overdueAlertedAt: null },
    select: {
      id: true, serviceType: true, serviceNote: true, dueAt: true,
      item: { select: { serialNumber: true, deviceName: true, homeUnit: true } },
    },
  });
  if (overdue.length === 0) return { alertedCount: 0 };

  const sender = deps.sender ?? getEmailSender();
  let alertedCount = 0;
  for (const s of overdue) {
    const daysOverdue = Math.abs(dueState(s.dueAt, now).days);
    const label = serviceTypeLabel(s.serviceType, s.serviceNote);
    const subject = `OVERDUE service: SN ${s.item.serialNumber}`;
    const text = [
      `A service item is past its completion deadline (${daysOverdue} day(s) overdue).`,
      ``,
      `SN: ${s.item.serialNumber}`,
      `Device: ${s.item.deviceName ?? "—"}`,
      `Unit: ${s.item.homeUnit ?? "—"}`,
      `Service: ${label}`,
      ``,
      `Complete this service or mark it done in the queue.`,
    ].join("\n");
    try {
      await sender.send({ to: adminInbox, subject, text });
      await prisma.serviceQueueItem.update({ where: { id: s.id }, data: { overdueAlertedAt: now } });
      alertedCount++;
    } catch (e) {
      console.error(`[service-timer-alert] failed to alert SN ${s.item.serialNumber}:`, e);
    }
  }
  return { alertedCount };
}
```

- [ ] **Step 4: Run it — expect PASS.**

```bash
npx vitest run src/modules/service-queue/timer-alert.service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/service-queue/timer-alert.service.ts src/modules/service-queue/timer-alert.service.test.ts
git commit -m "feat(timers): add overdue service-item alert sweep"
```

---

## Task 8: Wire both sweeps into the cron route

**Files:**
- Modify: `src/app/api/cron/purge/route.ts` (`handle` ~28-48)

**Interfaces:**
- Consumes: `sendOverdueTransferAlerts`, `sendOverdueServiceAlerts`.

- [ ] **Step 1: Add imports and extend the `Promise.all`**

```ts
import { sendOverdueTransferAlerts } from "@/modules/transfers/timer-alert.service";
import { sendOverdueServiceAlerts } from "@/modules/service-queue/timer-alert.service";
```

Replace the `Promise.all` block and JSON response:

```ts
    const [transfers, users, transferAlerts, serviceAlerts] = await Promise.all([
      purgeExpiredTransfers(now),
      purgeDeactivatedUsers(now),
      sendOverdueTransferAlerts(now),
      sendOverdueServiceAlerts(now),
    ]);
    return NextResponse.json({
      ok: true,
      transfers: { deletedCount: transfers.deletedCount },
      users: { deletedCount: users.deletedCount, skippedCount: users.skipped.length },
      alerts: { overdueTransfers: transferAlerts.alertedCount, overdueService: serviceAlerts.alertedCount },
    });
```

- [ ] **Step 2: Type-check the route** (no unit test for the wiring; the sweeps are covered in Tasks 6–7):

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual smoke (optional, local dev)** — with `CRON_SECRET` and `ADMIN_INBOX_EMAIL` set, `curl` the route and confirm the JSON includes an `alerts` object:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/purge
```

Expected: `{"ok":true,...,"alerts":{"overdueTransfers":<n>,"overdueService":<n>}}`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/purge/route.ts
git commit -m "feat(timers): run overdue-alert sweeps from the daily cron route"
```

---

## Task 9: Edit / clear a hand receipt's `dueAt`

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts` (add `setTransferDueAt`)
- Create: `src/app/admin/actions/receipt-timer.ts`
- Test: `src/app/admin/actions/receipt-timer.test.ts`

**Interfaces:**
- Consumes: `getTransferByReceiptNumber`, `assertTransferOpen`, `computeDueAt`, `requireAdmin`.
- Produces:
  - `setTransferDueAt(id: string, dueAt: Date | null): Promise<void>` in `transfers.service.ts` (sets `dueAt` + resets `overdueAlertedAt: null`).
  - `setReceiptDueAtAction(_prev, formData): Promise<{ error?: string; ok?: true }>` — fields: `receiptNumber` (string), `returnDays` (string; blank = clear the timer).

- [ ] **Step 1: Write the failing test** (mock `@/lib/prisma` + `@/lib/authz`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/authz", () => ({ requireAdmin: vi.fn(async () => ({ id: "u1", role: "ADMIN" })) }));
vi.mock("@/lib/prisma", () => ({
  default: { transfer: { findUnique: vi.fn(), update: vi.fn(async () => ({})) } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { setReceiptDueAtAction } from "./receipt-timer";

const openRow = { id: "t1", receiptNumber: "HR-000001", status: "OPEN", closedAt: null };

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("setReceiptDueAtAction", () => {
  it("sets a new deadline and clears overdueAlertedAt on an open receipt", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(openRow as never);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "14" }));
    expect(res).toEqual({ ok: true });
    const arg = vi.mocked(prisma.transfer.update).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "t1" });
    expect(arg.data.dueAt).toBeInstanceOf(Date);
    expect(arg.data.overdueAlertedAt).toBeNull();
  });

  it("clears the timer when returnDays is blank", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(openRow as never);
    await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "" }));
    expect(vi.mocked(prisma.transfer.update).mock.calls[0][0].data.dueAt).toBeNull();
  });

  it("rejects editing a closed receipt", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce({ ...openRow, status: "CLOSED", closedAt: new Date() } as never);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "14" }));
    expect(res.error).toBeTruthy();
    expect(prisma.transfer.update).not.toHaveBeenCalled();
  });

  it("returns an error when the receipt is missing", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(null);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-NOPE", returnDays: "14" }));
    expect(res.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
npx vitest run src/app/admin/actions/receipt-timer.test.ts
```

- [ ] **Step 3: Implement**

Add to `transfers.service.ts`:

```ts
// Set or clear a receipt's return deadline. Resets overdueAlertedAt so a fresh
// deadline can alert again. Caller must verify the receipt is OPEN first.
export async function setTransferDueAt(id: string, dueAt: Date | null): Promise<void> {
  await prisma.transfer.update({ where: { id }, data: { dueAt, overdueAlertedAt: null } });
}
```

Create `src/app/admin/actions/receipt-timer.ts`:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { setTransferDueAt } from "@/modules/transfers/transfers.service";
import { assertTransferOpen } from "@/modules/transfers/lifecycle";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { computeDueAt } from "@/modules/timers/due";

const schema = z.object({
  receiptNumber: z.string().min(1),
  // Blank clears the timer; otherwise a positive whole number of days from now.
  returnDays: z.string().optional(),
});

export async function setReceiptDueAtAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid input." };

  const raw = (parsed.data.returnDays ?? "").trim();
  let dueAt: Date | null = null;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || n > 3650) return { error: "Enter a whole number of days between 1 and 3650." };
    dueAt = computeDueAt(new Date(), n);
  }

  try {
    const t = await prisma.transfer.findUnique({
      where: { receiptNumber: parsed.data.receiptNumber.toUpperCase() },
      select: { id: true, status: true, closedAt: true },
    });
    if (!t) return { error: "Receipt not found." };
    assertTransferOpen(t); // throws TransferError("CLOSED") on a closed receipt
    await setTransferDueAt(t.id, dueAt);
  } catch (e) {
    if (e instanceof TransferError && e.code === "CLOSED") return { error: "This receipt is closed and cannot be changed." };
    console.error("[setReceiptDueAtAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath(`/receipts/${parsed.data.receiptNumber}`);
  return { ok: true };
}
```

- [ ] **Step 4: Run it — expect PASS.**

```bash
npx vitest run src/app/admin/actions/receipt-timer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/transfers.service.ts src/app/admin/actions/receipt-timer.ts src/app/admin/actions/receipt-timer.test.ts
git commit -m "feat(timers): admin action to set/clear a hand receipt's return deadline"
```

---

## Task 10: Due badge component + queue view-model

**Files:**
- Create: `src/components/DueBadge.tsx`
- Modify: `src/components/service-queue-view.ts` (`QueueSortField` ~11; `QueueRowVM` ~13-21; `QUEUE_COLUMNS` ~26-31; add due-aware sort)
- Test: `src/components/service-queue-view.test.ts` (extend), `src/components/DueBadge` is verified in-browser (Task 14)

**Interfaces:**
- Consumes: `dueState` from `@/modules/timers/due`.
- Produces:
  - `<DueBadge dueAt={string | null} now?={number} />` — renders a colored label (`Overdue Nd` / `Due in Nd` / `On track` / `—`). Accepts an ISO string so it is RSC-serializable.
  - `QueueRowVM.dueAt: string | null` (ISO); `QueueSortField` includes `"due"`; a `"due"` column labelled `Due`.

- [ ] **Step 1: Write the failing test** (extend `service-queue-view.test.ts` — sorting by `due` puts overdue/soonest first, nulls last)

```ts
import { sortQueueRows } from "./service-queue-view";

describe("sortQueueRows by due", () => {
  const mk = (id: string, dueAt: string | null) => ({
    id, itemId: id, serialNumber: id, deviceName: null, homeUnit: null,
    serviceType: "Repair", serviceTypeRaw: "REPAIR" as const, dueAt,
  });
  it("orders soonest/overdue first and nulls last (asc)", () => {
    const rows = [mk("a", null), mk("b", "2026-07-20T00:00:00.000Z"), mk("c", "2026-07-10T00:00:00.000Z")];
    const out = sortQueueRows(rows, "due", "asc").map((r) => r.id);
    expect(out).toEqual(["c", "b", "a"]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`due` not a sort field; `dueAt` not on VM).

```bash
npx vitest run src/components/service-queue-view.test.ts
```

- [ ] **Step 3: Implement the view-model changes**

In `service-queue-view.ts`:

```ts
export type QueueSortField = "serialNumber" | "deviceName" | "homeUnit" | "serviceType" | "due";
```

Add `dueAt` to `QueueRowVM`:

```ts
  serviceTypeRaw: "REIMAGE" | "REPAIR" | "OTHER"; // for filtering
  dueAt: string | null; // ISO; null = no timer
```

Add the column:

```ts
export const QUEUE_COLUMNS: { key: QueueSortField; label: string }[] = [
  { key: "serialNumber", label: "SN" },
  { key: "deviceName", label: "Device Name" },
  { key: "homeUnit", label: "Unit" },
  { key: "serviceType", label: "Service Type" },
  { key: "due", label: "Due" },
];
```

Because generic `sortRows` can't rank nulls-last by date, special-case `due` in `sortQueueRows`:

```ts
export function sortQueueRows(rows: QueueRowVM[], field: QueueSortField | null, dir: SortDir): QueueRowVM[] {
  if (field === "due") {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      // Nulls (no timer) always sort last regardless of direction.
      if (a.dueAt === null && b.dueAt === null) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return sign * (Date.parse(a.dueAt) - Date.parse(b.dueAt));
    });
  }
  return sortRows(rows, field, dir);
}
```

- [ ] **Step 4: Implement `src/components/DueBadge.tsx`**

```tsx
import { dueState } from "@/modules/timers/due";

// Colored due/overdue pill shared by the queue table, dashboard, and receipt
// page. Takes an ISO string (RSC-serializable) and an optional `now` epoch so
// callers can pass a single stable timestamp for a whole list.
export function DueBadge({ dueAt, now }: { dueAt: string | null; now?: number }) {
  const state = dueState(dueAt ? new Date(dueAt) : null, now != null ? new Date(now) : undefined);
  if (state.state === "none") return <span className="subtle">—</span>;
  const label =
    state.state === "overdue" ? `Overdue ${Math.abs(state.days)}d`
    : state.state === "soon" ? `Due in ${state.days}d`
    : `Due in ${state.days}d`;
  const cls =
    state.state === "overdue" ? "due-badge due-badge--overdue"
    : state.state === "soon" ? "due-badge due-badge--soon"
    : "due-badge due-badge--ontrack";
  return <span className={cls}>{label}</span>;
}
```

Add matching styles to the global stylesheet (find where existing badges/pills live, e.g. `src/app/globals.css`; follow the existing badge/`alert-*` pattern). Minimum:

```css
.due-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.due-badge--overdue { background: #fdecea; color: #9b1c1c; }
.due-badge--soon { background: #fef7e0; color: #8a6d00; }
.due-badge--ontrack { background: #e7f4ea; color: #1e6b34; }
```

(Confirm the actual stylesheet path and dark-mode conventions in the repo before adding; match them.)

- [ ] **Step 5: Run the view test — expect PASS; type-check the component.**

```bash
npx vitest run src/components/service-queue-view.test.ts
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/DueBadge.tsx src/components/service-queue-view.ts src/components/service-queue-view.test.ts src/app/globals.css
git commit -m "feat(timers): add DueBadge and a sortable Due column to the queue view-model"
```

---

## Task 11: Render the Due column in the queue table + page

**Files:**
- Modify: `src/components/ServiceQueueTable.tsx` (header ~114-119; body cells ~122-138)
- Modify: `src/app/admin/queue/page.tsx` (VM mapping ~17-25)

**Interfaces:**
- Consumes: `DueBadge`, `QueueRowVM.dueAt`.

- [ ] **Step 1: Map `dueAt` into the VM** in `queue/page.tsx`:

```ts
  const vms: QueueRowVM[] = rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    serialNumber: r.item.serialNumber,
    deviceName: r.item.deviceName,
    homeUnit: r.item.homeUnit,
    serviceTypeRaw: r.serviceType,
    serviceType: serviceTypeLabel(r.serviceType, r.serviceNote),
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
  }));
```

For `r.dueAt` to exist on `QueueRow`, `listActiveQueue` must select it — add `dueAt: true` to `queueItemSelect`? No: `dueAt` is on `ServiceQueueItem` itself, which `findMany` returns in full (the `select` in `listActiveQueue` is on the nested `item`/`transfer` includes, not the root). So `r.dueAt` is already present. Verify by type-check.

- [ ] **Step 2: Render the column** in `ServiceQueueTable.tsx`. Add the import:

```tsx
import { DueBadge } from "@/components/DueBadge";
```

Add a body cell alongside the others (guarded by `isHidden("due")`), after the Service Type cell:

```tsx
                  {!isHidden("due") && <td data-label="Due"><DueBadge dueAt={r.dueAt} /></td>}
```

The header already iterates `visibleCols`, so the `Due` column header renders automatically from `QUEUE_COLUMNS`.

- [ ] **Step 3: Type-check + run the queue view test:**

```bash
npx tsc --noEmit
npx vitest run src/components/service-queue-view.test.ts
```

Expected: no type errors; tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/ServiceQueueTable.tsx src/app/admin/queue/page.tsx
git commit -m "feat(timers): show the Due column on the service queue"
```

---

## Task 12: Dashboard queries + `/admin` dashboard page

**Files:**
- Create: `src/app/admin/dashboard/dashboard.service.ts`
- Modify: `src/app/admin/page.tsx` (replace the whole redirect body)

**Interfaces:**
- Consumes: `prisma`, `dueState`, `DUE_SOON_DAYS`, `serviceTypeLabel`.
- Produces (in `dashboard.service.ts`):
  - `type TransferTimerRow = { receiptNumber: string; itemSummary: string; dueAt: string }`
  - `type ServiceTimerRow = { itemId: string; serialNumber: string; deviceName: string | null; serviceType: string; dueAt: string }`
  - `getTimerDashboard(now?: Date): Promise<{ overdueTransfers: TransferTimerRow[]; soonTransfers: TransferTimerRow[]; overdueService: ServiceTimerRow[]; soonService: ServiceTimerRow[] }>`

- [ ] **Step 1: Implement `dashboard.service.ts`** (server-only; queries active records with a timer due within the soon window or already overdue, then splits by `dueState`)

```ts
import "server-only";
import prisma from "@/lib/prisma";
import { dueState, DUE_SOON_DAYS, computeDueAt } from "@/modules/timers/due";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";

export type TransferTimerRow = { receiptNumber: string; itemSummary: string; dueAt: string };
export type ServiceTimerRow = { itemId: string; serialNumber: string; deviceName: string | null; serviceType: string; dueAt: string };

export async function getTimerDashboard(now: Date = new Date()) {
  const horizon = computeDueAt(now, DUE_SOON_DAYS); // overdue + due within the soon window
  const [transfers, service] = await Promise.all([
    prisma.transfer.findMany({
      where: { status: "OPEN", dueAt: { not: null, lte: horizon } },
      orderBy: { dueAt: "asc" },
      select: { receiptNumber: true, itemSummary: true, dueAt: true },
    }),
    prisma.serviceQueueItem.findMany({
      where: { status: "PENDING", dueAt: { not: null, lte: horizon } },
      orderBy: { dueAt: "asc" },
      select: { itemId: true, serviceType: true, serviceNote: true, dueAt: true, item: { select: { serialNumber: true, deviceName: true } } },
    }),
  ]);

  const overdueTransfers: TransferTimerRow[] = [];
  const soonTransfers: TransferTimerRow[] = [];
  for (const t of transfers) {
    const row = { receiptNumber: t.receiptNumber, itemSummary: t.itemSummary, dueAt: t.dueAt!.toISOString() };
    (dueState(t.dueAt, now).state === "overdue" ? overdueTransfers : soonTransfers).push(row);
  }

  const overdueService: ServiceTimerRow[] = [];
  const soonService: ServiceTimerRow[] = [];
  for (const s of service) {
    const row = { itemId: s.itemId, serialNumber: s.item.serialNumber, deviceName: s.item.deviceName, serviceType: serviceTypeLabel(s.serviceType, s.serviceNote), dueAt: s.dueAt!.toISOString() };
    (dueState(s.dueAt, now).state === "overdue" ? overdueService : soonService).push(row);
  }

  return { overdueTransfers, soonTransfers, overdueService, soonService };
}
```

- [ ] **Step 2: Replace `src/app/admin/page.tsx`** with the dashboard (keep the existing `requireAdmin` + `AuthError` redirect guard). Render two cards, each with an Overdue section and a Due-soon section, using `DueBadge`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getTimerDashboard } from "./dashboard/dashboard.service";
import { DueBadge } from "@/components/DueBadge";

export default async function AdminHome() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const now = Date.now();
  const { overdueTransfers, soonTransfers, overdueService, soonService } = await getTimerDashboard(new Date(now));

  return (
    <div className="stack">
      <h1 className="page-title">Admin dashboard</h1>

      <section className="card stack-sm">
        <h2>Hand receipts — overdue ({overdueTransfers.length})</h2>
        {overdueTransfers.length === 0 ? <p className="subtle">Nothing overdue.</p> : (
          <ul>
            {overdueTransfers.map((t) => (
              <li key={t.receiptNumber}>
                <Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link> — {t.itemSummary}{" "}
                <DueBadge dueAt={t.dueAt} now={now} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="subtle">Due soon ({soonTransfers.length})</h3>
        <ul>
          {soonTransfers.map((t) => (
            <li key={t.receiptNumber}>
              <Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link> — {t.itemSummary}{" "}
              <DueBadge dueAt={t.dueAt} now={now} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack-sm">
        <h2>Service items — overdue ({overdueService.length})</h2>
        {overdueService.length === 0 ? <p className="subtle">Nothing overdue.</p> : (
          <ul>
            {overdueService.map((s) => (
              <li key={s.itemId}>
                <Link href={`/i/${s.itemId}`}>SN {s.serialNumber}</Link> — {s.serviceType}{" "}
                <DueBadge dueAt={s.dueAt} now={now} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="subtle">Due soon ({soonService.length})</h3>
        <ul>
          {soonService.map((s) => (
            <li key={s.itemId}>
              <Link href={`/i/${s.itemId}`}>SN {s.serialNumber}</Link> — {s.serviceType}{" "}
              <DueBadge dueAt={s.dueAt} now={now} />
            </li>
          ))}
        </ul>
        <p><Link href="/admin/queue">Open the full service queue →</Link></p>
      </section>
    </div>
  );
}
```

(Confirm the page shell/layout matches sibling admin pages — `admin/queue/page.tsx` renders a bare `stack` div under a shared layout. Match whatever wrapper those use.)

- [ ] **Step 3: Type-check:**

```bash
npx tsc --noEmit
```

Expected: no errors. (No unit test — this is a data-composition + render page; it is verified in-browser in Task 14. The query splitting is pure `dueState`, already tested in Task 2.)

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/dashboard/dashboard.service.ts src/app/admin/page.tsx
git commit -m "feat(timers): admin dashboard with overdue/due-soon hand receipts and service items"
```

---

## Task 13: UI inputs — Return-by control + per-item override + receipt edit control

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (add a "Return by" control posting `returnDays`; add a per-serial override field posting `service[<itemId>][days]` next to the existing "Needs service?" block)
- Modify: `src/app/i/[itemId]/page.tsx` (add an override `days` field to the service-flag form; show current `dueAt` via `DueBadge`)
- Modify: `src/app/receipts/[receiptNumber]/page.tsx` (show `dueAt` state; admin-only set/extend/clear control calling `setReceiptDueAtAction`)

**Interfaces:**
- Consumes: `setReceiptDueAtAction`, `DueBadge`. Form field names must match the parsers: `returnDays`, `service[<itemId>][days]`.

> Read each target file first and follow its existing form/markup conventions (these are large components). The snippets below are the required field names and wiring, not a license to restructure.

- [ ] **Step 1: Return-by control on the builder**

In `ReceiptBuilderForm.tsx`, add one optional control to the receipt form (near the sender/receiver block) posting `returnDays`. Preset buttons set a number input's value; blank = no timer:

```tsx
{/* Return timer (optional): blank = no timer. Presets set the days field. */}
<fieldset className="stack-sm">
  <legend>Return by (optional)</legend>
  <div className="row">
    {[7, 30, 90].map((d) => (
      <button key={d} type="button" className="btn btn-secondary btn-sm"
        onClick={() => setReturnDays(String(d))}>{d}d</button>
    ))}
    <input name="returnDays" inputMode="numeric" pattern="[0-9]*" placeholder="custom days"
      value={returnDays} onChange={(e) => setReturnDays(e.target.value.replace(/[^0-9]/g, ""))} />
  </div>
  <span className="subtle" style={{ fontSize: 12 }}>Leave blank for no return timer.</span>
</fieldset>
```

Add `const [returnDays, setReturnDays] = useState("")` with the component's other state.

- [ ] **Step 2: Per-serial service override on the builder**

Wherever the builder renders the per-serial "Needs service?" + type/note fields (keys `service[<itemId>][needs|type|note]`), add an optional days input in the same group:

```tsx
<input name={`service[${itemId}][days]`} inputMode="numeric" pattern="[0-9]*"
  placeholder="SLA days (default by type)" />
```

- [ ] **Step 3: Item-page service override + due display**

In `src/app/i/[itemId]/page.tsx`, in the existing service-flag form, add the same optional `overrideDays` input (the form submits to `setServiceAction`, whose `setSchema` now accepts `overrideDays`):

```tsx
<input name="overrideDays" inputMode="numeric" pattern="[0-9]*" placeholder="SLA days (optional)" />
```

And, where the item's current service request is shown, render its deadline:

```tsx
<DueBadge dueAt={serviceRequest.dueAt ? serviceRequest.dueAt.toISOString() : null} />
```

(Use whatever variable that page already holds the `getServiceRequestForItem` result in.)

- [ ] **Step 4: Receipt-page timer display + admin edit control**

In `src/app/receipts/[receiptNumber]/page.tsx`, show the current timer in the details card:

```tsx
<div><strong>Return by:</strong> {t.dueAt ? <>{formatDateTimeHST(t.dueAt)} <DueBadge dueAt={t.dueAt.toISOString()} /></> : <span className="subtle">No timer</span>}</div>
```

And, for admins on an open receipt, a small form to set/extend/clear it (blank clears):

```tsx
{isAdmin && !closed && (
  <form action={setReceiptDueAtAction} className="row">
    <input type="hidden" name="receiptNumber" value={t.receiptNumber} />
    <input name="returnDays" inputMode="numeric" pattern="[0-9]*" placeholder="days (blank clears)" />
    <button type="submit" className="btn btn-secondary btn-sm">Update return timer</button>
  </form>
)}
```

Add the imports (`DueBadge`, and `setReceiptDueAtAction` from `@/app/admin/actions/receipt-timer`). `formatDateTimeHST` is already imported.

- [ ] **Step 5: Type-check + run affected unit tests**

```bash
npx tsc --noEmit
npx vitest run src/app/receipts/new/ReceiptBuilderForm.test.tsx
```

Expected: no type errors; the existing builder test still passes (update it only if a required field selector changed).

- [ ] **Step 6: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx "src/app/i/[itemId]/page.tsx" "src/app/receipts/[receiptNumber]/page.tsx"
git commit -m "feat(timers): return-by input, per-item SLA override, and receipt timer editing UI"
```

---

## Task 14: Full-suite gate + in-browser verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite** (single worker — the DB is shared; do not run in parallel with another agent):

```bash
npx vitest run
```

Expected: all tests pass, including the new timer tests.

- [ ] **Step 2: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: In-browser verification** (jsdom/build are NOT visual proof — per project rule). Using the `verify`/`run` skill or a real browser against `npm run dev`, with `ADMIN_INBOX_EMAIL` and a mail sender configured (or the `LogEmailSender` stub for the email path):
  - Build a hand receipt with a 7-day return timer and one item flagged for service with an override → confirm `dueAt` persists (receipt page shows "Return by" + badge; queue shows the Due column).
  - Visit `/admin` → the dashboard renders overdue/due-soon cards; seed a past `dueAt` (e.g. via `prisma studio` or SQL on the dev DB) to see an item appear under "overdue" with a red badge.
  - Hit `/api/cron/purge` with the `CRON_SECRET` header → response includes `alerts: { overdueTransfers, overdueService }`; the overdue records get `overdueAlertedAt` stamped and a second call reports `0` (idempotent). Check the stub/console or inbox for the two email bodies.
  - Edit a receipt's timer on the receipt page (set, extend, clear) as admin; confirm a closed receipt shows no edit control.
  - Check the Due column, badges, dashboard cards, and the builder control on a mobile viewport width.

- [ ] **Step 4: Commit any fixes, then finish the branch** via the `superpowers:finishing-a-development-branch` skill.

---

## Self-review — spec coverage

- Optional per-receipt return timer (presets + custom days): Tasks 1, 4, 13. ✓
- Editable after creation (extend/clear, open-only, resets alert): Task 9, 13. ✓
- Per-service-type SLA (3/7/5) + override, starts at flag, stops at complete: Tasks 1, 3, 5 (stop = status filter in Task 7/12). ✓
- One overdue email at expiry to `ADMIN_INBOX_EMAIL`, idempotent, failures retried: Tasks 6, 7. ✓
- Cron wiring, no workflow change: Task 8. ✓
- `/admin` dashboard (overdue + due-soon cards) replacing the redirect: Task 12. ✓
- Service timers on the existing queue (Due column, sortable/filterable): Tasks 10, 11. ✓
- Hand-receipt timer on the receipt page (deviation from "receipts list" — no such page): Task 13. ✓
- Tests + browser verification, secrets via config, closed-immutability, server-only: Tasks 6–9, 14 + Global Constraints. ✓
