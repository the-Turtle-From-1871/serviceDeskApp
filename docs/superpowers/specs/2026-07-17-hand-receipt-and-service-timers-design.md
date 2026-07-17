# Hand-Receipt Return Timers & Service-Desk SLA Timers

**Date:** 2026-07-17
**Status:** Approved design — ready for implementation planning

## Problem

Two categories of loaned/held property currently have no time tracking:

1. **Hand receipts (loaned-out devices).** When the admin lends a device, there is
   no return deadline and nothing that flags a device that has been out too long.
2. **Service-queue items (turned-in devices).** Items flagged for Reimage / Repair /
   Other sit in the queue with no completion target, so nothing signals when the
   service desk is running late.

We want an optional **return timer** on each hand receipt and a **completion SLA
timer** on each service-queue item. When a timer lapses, the admin gets a single
email alert, and overdue/due-soon work is visible at a glance on screen.

## Goals

- Optional per-receipt return deadline, set on the hand-receipt builder and
  editable afterward while the receipt is open.
- Per-service-type default completion SLA, auto-applied when an item is flagged,
  with an optional per-item override.
- Exactly one "overdue" email per record, sent to the shared admin inbox.
- A new `/admin` dashboard summarizing overdue / due-soon work, plus inline
  due/overdue badges on the service queue and the receipts list.

## Non-goals (YAGNI)

- No reminder-before-due or repeated-after-due emails. One alert at expiry only.
- No per-recipient routing; all alerts go to the single shared admin inbox.
- No SLA analytics / historical on-time reporting.
- No pausing/snoozing timers.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Hand-receipt timer input | Quick presets (7 / 30 / 90 days) **plus** a custom "N days" field; optional (blank = no timer). Deadline = created date + N days. |
| Alert cadence | **Once at expiry only.** |
| Alert recipient | Shared admin inbox via `ADMIN_INBOX_EMAIL` = `dcsimservicedesk@gmail.com`. Wired through config, never hardcoded. |
| Service SLA | Per-service-type default, overridable per item. Defaults: **Reimage 3d, Repair 7d, Other 5d.** Timer starts when flagged, stops when completed. |
| On-screen | New `/admin` dashboard (replaces the redirect) with overdue/due-soon cards, **plus** inline badge columns. Service timers live primarily on the existing `/admin/queue`. |
| Editable deadline | `dueAt` is editable after creation (extend/clear) while the record is still active. |

## Architecture

Reuses the existing "compute a deadline timestamp → index it → sweep it from the
daily cron" pattern already used by `purgeAfter` / `purgeExpiredTransfers`.

### 1. Data model (`prisma/schema.prisma`)

Add to **`Transfer`**:

```prisma
dueAt            DateTime?   // return-by deadline; null = no timer
overdueAlertedAt DateTime?   // set when the overdue email is sent (idempotency)
// @@index([dueAt])
```

Add to **`ServiceQueueItem`**:

```prisma
dueAt            DateTime?   // complete-by deadline; null = no timer
overdueAlertedAt DateTime?
// @@index([dueAt])
```

Migration authored via `migrate diff --script` + `migrate deploy` (per project
memory, `prisma migrate dev` cannot run in this shell), then `npx prisma generate`.

**Why timers stop automatically:** the alert sweep and the dashboard only consider
*active* records — hand receipts with `status = OPEN` and service items with
`status = PENDING`. When a receipt is returned/closed or an item is marked
completed, it drops out of every timer query. No explicit "cancel timer" step.

### 2. Setting / editing deadlines

**Deadline helper** — add beside `computePurgeAfter` in
`src/modules/transfers/lifecycle.ts`:

```ts
export function computeDueAt(from: Date, days: number): Date // from + days*24h
```

Day math is whole days added to the creation instant (UTC-stored timestamp);
overdue = `now >= dueAt`. "Due soon" threshold = `dueAt <= now + 3 days`.

**Hand receipt (create):** the builder gets a "Return by" control — preset
buttons (7 / 30 / 90) plus a custom days field, optional. `createReceiptAction`
parses the days value and `createTransfer` stamps
`dueAt = computeDueAt(createdAt, days)` when provided.

**Hand receipt (edit):** a new admin server action `setReceiptDueAtAction` on the
receipt detail page sets/extends/clears `dueAt`. Guard: `requireAdmin()` +
`assertTransferOpen()` (closed receipts are immutable). On any change to a future
date, reset `overdueAlertedAt = null` so the new deadline can alert if it lapses.

**Service SLA defaults** — a single source of truth, e.g.
`src/modules/service-queue/sla.ts`:

```ts
export const SLA_DAYS: Record<ServiceType, number> =
  { REIMAGE: 3, REPAIR: 7, OTHER: 5 }
export function computeServiceDueAt(type: ServiceType, from: Date, overrideDays?: number): Date
```

`upsertServiceRequest` accepts an optional `overrideDays` and stamps `dueAt`
using `SLA_DAYS[type]` (or the override). Re-flagging / changing the override
recomputes `dueAt` and resets `overdueAlertedAt = null`. The flag UI (builder
per-serial + item detail page) gets an optional "complete within N days" override
field.

### 3. Alert sweep (cron)

Two new `import "server-only"` sweep functions:

- `src/modules/transfers/timer-alert.service.ts` → `sendOverdueTransferAlerts(now)`
- `src/modules/service-queue/timer-alert.service.ts` → `sendOverdueServiceAlerts(now)`

Each:

1. Query active + lapsed + not-yet-alerted records:
   - Transfers: `status = OPEN AND dueAt <= now AND overdueAlertedAt IS NULL`.
   - Service items: `status = PENDING AND dueAt <= now AND overdueAlertedAt IS NULL`.
2. For each, send one email to `ADMIN_INBOX_EMAIL` via `getEmailSender()` using a
   new template beside `send-receipt-email.ts`
   (`src/modules/receipts/send-overdue-email.ts` or a shared alerts module).
   Body identifies the record (receipt number + item summary, or SN + device +
   unit + service type) and how many days overdue.
3. On successful send, stamp `overdueAlertedAt = now`. **Send failures are
   surfaced/logged (pickup-email style, not swallowed)** and leave
   `overdueAlertedAt` null so the record retries on the next daily run.

**Wiring:** call both from the existing `/api/cron/purge` route handler's
`Promise.all` (alongside `purgeExpiredTransfers` / `purgeDeactivatedUsers`). That
route already runs daily via `.github/workflows/purge-cron.yml` and is
`CRON_SECRET`-guarded, so **no GitHub Actions workflow changes are needed** (the
`workflow`-scope push limitation in project memory makes this the right call). The
JSON summary gains `overdueTransfersAlerted` / `overdueServiceAlerted` counts.

### 4. Dashboard + inline badges

- **New `/admin` dashboard** — replace `AdminHome`'s `redirect("/items")` in
  `src/app/admin/page.tsx` with a server component that renders two cards:
  - **Overdue hand receipts** — open transfers past `dueAt`, plus a due-soon
    (≤3d) subsection; each row links to the receipt.
  - **Overdue service items** — pending items past `dueAt`, plus due-soon; each
    row links to the item.
  Data via small `server-only` query helpers (`listOverdueTransfers`,
  `listOverdueServiceItems`, or a combined dashboard query).
- **Service queue (`/admin/queue`)** — add a color-coded **Due** column to
  `QueueRowVM` + `ServiceQueueTable` (🔴 overdue Nd / 🟡 due-soon / ⚪ on-track /
  "—" none), sortable and filterable by soonest-due. Primary home for service
  timers.
- **Receipts list** — same due/overdue badge column for open hand receipts.

A shared presentation helper computes badge state from `dueAt` + `now` so the
dashboard, queue, and receipts list render timers identically.

## Error handling & security

- All new server actions start with `requireAdmin()` (IDOR/access-control guard).
- Editing `dueAt` rejected on closed receipts (`assertTransferOpen`).
- Days input validated with Zod (positive integer, sane upper bound) before use.
- Cron sweeps stay behind `isAuthorized`/`CRON_SECRET`; no new public surface.
- Admin inbox address read from `ADMIN_INBOX_EMAIL`, never hardcoded.
- Email send errors logged server-side; client/cron response stays generic.

## Testing

Integration (Vitest, `npx vitest run integration`), email sender mocked:

- `computeDueAt` and `computeServiceDueAt` (defaults + override) day math.
- `createTransfer` stamps `dueAt` when days provided, leaves null when blank.
- `upsertServiceRequest` stamps `dueAt` from `SLA_DAYS[type]` and from override;
  re-flag resets `overdueAlertedAt`.
- `setReceiptDueAtAction`: sets/extends/clears; resets `overdueAlertedAt`;
  rejected when closed.
- `sendOverdueTransferAlerts` / `sendOverdueServiceAlerts`: overdue+unalerted →
  emailed once + `overdueAlertedAt` stamped; closed/completed excluded;
  already-alerted skipped; send failure leaves `overdueAlertedAt` null.

Visual (real browser, per project rule that jsdom/build are not visual proof):
dashboard cards, queue Due column, receipts badge column, and the builder
"Return by" control across desktop + mobile.

## Rollout notes

- Set `ADMIN_INBOX_EMAIL=dcsimservicedesk@gmail.com` in the deploy environment.
- Apply the migration to prod via the manual Supabase-MCP path (per project
  memory) before pushing code that reads the new columns.
- Existing open receipts / pending items get `dueAt = null` (no timer) until
  edited — no backfill required.
