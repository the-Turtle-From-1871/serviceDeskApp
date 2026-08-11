# Bulk actions on a scanned batch — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Builds on:** `2026-08-10-multi-item-scan-design.md` — shipped as `886e946` *feat(items): multi-item scanning on /items (#109)*. That design is **not** superseded; this extends it.
**Surface:** the `/items` selection bar and `ItemSelectionProvider`. The scan sheet, the create-unknowns form and the label hints are untouched.

## Problem

#109 made scanning collect a batch and commit it to the `/items` selection, which already
offers five bulk actions: Create receipt, Print QR codes, Mark as on hand, Set readiness and
Change category. Against the four workflows the desk actually runs — turn-in, inventory
sweep, issuing out, service triage — two gaps remain.

1. **Three actions the desk needs are per-item only.** `markAuditedAction` takes one item and
   one signature; `upsertServiceRequest` takes one item; `completeServiceItem` takes a
   *queue-row* id. The inventory sweep is the worst affected: confirming a shelf means
   signing once per device, so a real sweep is not attempted at all. This is why
   `Item.lastAuditedAt` is populated on a small fraction of the fleet.

2. **The batch is in-memory.** `ItemSelectionProvider` holds a `useState` Map. A 150-item
   sweep is lost to a screen lock, a reload or a back-swipe, and — worse than losing it —
   there is no way to tell which devices were already scanned, so the sweep restarts from
   zero. #109 listed persistence as an explicit non-goal; that was right for a desk-side
   batch of thirty and is wrong for a room sweep.

## Non-goals

- No change to the scan flow, the dedupe/in-flight rules, the create-unknowns form, or the
  QR label hints. #109 owns all of it.
- No new scan surface. A dedicated `/items/scan` page was considered and rejected — see
  *Rejected alternatives*.
- No new capability. The three actions gate on capabilities that already exist.
- **No bulk `homeUnit` and no bulk `storageLocation`.** Both are importable columns, so the
  nightly Drive import overwrites them within a day. A control that quietly undoes itself is
  worse than no control.
- No CSV manifest export of the batch. Considered, dropped as the weakest of the four
  candidates.
- No offline queue. The camera resolves each scan against the server as it always has; this
  design persists the *result*, not the ability to scan while disconnected.

## What changes, from the operator's side

- The selection bar gains a **More actions** sheet holding three new entries: *Record
  audit…*, *Flag for service…*, and *Complete service*.
- **The selection survives** a reload, a screen lock, a back-swipe and a re-login. The bar
  shows when the batch was started.
- Each action **reports what it skipped**: *"Audited 47 · skipped 2 retired."*

## Architecture

### 1. Persistence moves into `ItemSelectionProvider`

The provider currently holds `useState<Map<string, SelectedItem>>`. It becomes
localStorage-backed through `makeStore` / `usePersistedPref` (`src/components/persisted-pref.ts`)
— the app's existing pattern, built on `useSyncExternalStore`, so the server snapshot is used
during SSR and the persisted value takes over on the client with no hydration mismatch and
no `setState`-in-effect. It also syncs across tabs for free.

**Stored as `SelectedItem[]`, exposed as a Map.** `makeStore`'s setter does
`JSON.stringify(value)`, and a `Map` stringifies to `{}` — so the stored shape is an array
and the Map is derived with `useMemo`. The public `ItemSelectionValue` contract
(`selected`, `toggle`, `addMany`, `removeMany`, `clear`) does not change, so
`ItemSelectTable` and `ItemsScanButton` are untouched.

**Persisting the whole `SelectedItem`, not ids.** #109 deliberately rejected ids-plus-refetch
because the Map already carries the make/model/serial/status the receipt-group validation
reads, and refetching would make two sources of truth. That reasoning holds here, and it
means rehydration costs **zero queries**.

**Staleness is answered on the server, not the client.** A persisted row could have been
retired or deleted hours later. Every bulk write below is an id-scoped `updateMany` /
`createMany` that re-checks status in the database, so a stale client copy can produce a
skip but never a wrong write. The client Map is display data; the server is the authority.

**A started-at stamp rides with the batch** and the bar renders it ("Batch started 4:12pm").
Nothing expires on a timer: silently discarding a sweep because it crossed midnight is worse
than showing a stale one that clears in a tap. `clear()` stays the only way out, and above
20 items it confirms first.

**The cap is `MAX_BULK_ITEMS` (500)**, already enforced server-side. `addMany` stops adding
at 500 and the scan sheet says so on the next scan — a hard stop, not a warning, so a
600-item batch cannot be collected and then fail at the end. Selecting by tapping is bounded
by the same rule, which is a behaviour change: the selection is uncapped today.

### 2. Three service functions — batched, never looped

Each enforces **no permissions** (the calling action owns the guard) and caps at
`MAX_BULK_ITEMS` as a backstop, matching `markItemsReady`.

**One rule across all three: retired items are excluded and reported, never refused.**
`markAuditedAction` today rejects a retired item outright. That is right for one item and
wrong for a batch — one retired device must not fail an audit of 150. Each returns
`{ updated, skipped }`. **This is a deliberate divergence and needs writing down**, because
the single-item path keeps its refusal.

#### `recordAudits(input)` — `src/modules/audit/audit.service.ts`

One transaction, four queries:

1. `findMany` the `ACTIVE` ids among the batch (`select: { id: true }`)
2. `putSignatureAsset(tx, image)` **once**
3. `createMany` the `ItemAudit` rows
4. `updateMany` `Item.lastAuditedAt`

Step 2 is why this is affordable at all: 150 audits reference one deduplicated
`SignatureAsset` row instead of 150 copies of the blob. Without the dedup work of 2026-08-09
this action would not be proposable.

`now` is computed in JS and **bound**, used for both the audit rows and `lastAuditedAt`,
rather than reading `audit.createdAt` back per row as the single-item path does. One bound
instant is exactly what the "the column cannot drift from the log" invariant wants, and it
matches how `staleDeviceWhere` already handles `now`.

**Step 3 must set `createdAt` explicitly.** `ItemAudit.createdAt` is
`@default(now())`, so an insert that omits it takes the *database's* clock per row — leaving
the audit rows and `lastAuditedAt` a few milliseconds apart and reintroducing exactly the
drift the bound instant exists to prevent. Pass `createdAt: now` in the `createMany` payload.

`ItemAudit` is append-only with no per-item unique constraint (only `@@index([itemId, createdAt])`),
so a double submit writes a second audit rather than failing. That is harmless — newest wins, and the log is meant to
accumulate — but the control still disables while its transition is pending.

#### `upsertServiceRequests(input)` — `src/modules/service-queue/service-queue.service.ts`

One transaction, four queries, preserving the deadline semantics exactly:

1. `findMany` which of the ids already have a `ServiceQueueItem`
2. `updateMany` scoped to `status: COMPLETED` → `{ dueAt: null, overdueAlertedAt: null }`
3. `updateMany` the existing rows → type, note, `PENDING`, `...serviceDueAtUpdate(overrideDays, now)`
4. `createMany({ skipDuplicates: true })` for ids with no row, using `computeServiceDueAt`

Step 2 is the **new-round reset** and must stay ahead of step 3: without it a device that
broke a second time inherits the first job's deadline and its `overdueAlertedAt`, which the
sweep's `overdueAlertedAt: null` filter turns into *this lapse can never alert*. The
single-item path guards this and the bulk path must too.

A blank override still means **no deadline on create, no change on update** — the two
functions keep owning their own question, and `serviceDueAtUpdate` returning `{}` is what
keeps a re-flag from re-basing a live deadline on `now`.

`transferId` is `null`: a scanned batch has no receipt behind it, same as the item-page flag.

#### `completeServiceItems(itemIds)` — `src/modules/service-queue/service-queue.service.ts`

One transaction, three queries:

1. `findMany` the `PENDING` queue rows for those item ids (`select: { id: true, itemId: true }`)
2. `updateMany` those rows → `COMPLETED`
3. `updateMany` the corresponding `ACTIVE` items → `markedReadyAt = now`

Step 1 replaces the single-item `canComplete` guard: a non-pending row simply is not in the
set, so a `COMPLETED` row is skipped rather than erroring. Steps 2 and 3 stay in one
transaction because "a queue row that says COMPLETED while the item was never marked on hand
is the inconsistency worth preventing". Like the single-item version it deliberately
**leaves** `dueAt` and `overdueAlertedAt` on the finished row.

### 3. Three server actions, filed next to their siblings

| Action | File | Guard |
| --- | --- | --- |
| `recordAuditsAction` | `src/app/admin/actions/audit.ts` | `requireAdmin()` (= `ADMINISTER`), matching `markAuditedAction` |
| `flagItemsForServiceAction` | `src/app/admin/actions/queue.ts` | `requireCapability("MANAGE_QUEUE")` |
| `completeServiceItemsAction` | `src/app/admin/actions/queue.ts` | `requireCapability("MANAGE_QUEUE")` |

Filed by domain rather than in a `scan-batch-actions.ts` grab bag: three capabilities in one
file invites gating them all the same way.

Each caps in the action too (readable message) and returns the repo's discriminated union —
`{ error: string } | { ok: true; updated: number; skipped: number }` — annotated, not
inferred, since a `"use server"` module may only export async functions.

The signer is resolved **server-side from the session**: the client posts only a
`signatureId`, and `getOwnedSignature(id, user.id)` scopes it to the acting admin, so a
client can neither forge a signer name nor use another admin's ink. The signature picker
ships **names only** (`listSignatureNames`) — no image blob reaches the browser.

The batch is client-supplied ids, so these guards are the entire boundary.

**Revalidation stays list-level**: `/items`, `/admin/queue`, `/admin/analytics`. Not 200
individual `/i/<id>` paths — `setReadinessAction` sets that precedent.

**The sheet gates per capability, not on `isAdmin`.** The eight actions now span four:
`MANAGE_QUEUE` (on hand, readiness, flag, complete), `MANAGE_ITEMS` (category, QR sheet),
`CREATE_RECEIPTS` (receipt), `ADMINISTER` (audit). An account granted only the service queue
sees the queue actions and nothing else.

### 4. The More-actions sheet

The bar is already at its height budget — it is sticky, overlays the table, and "stacked, it
covered a phone viewport entirely". Three more controls, two of which need their own input
(a signature picker; a service type + note + optional deadline), do not fit inline. They go
behind one **More actions** button opening a popover sheet.

That means `SortFilterMenu`'s rules apply verbatim, all of them load-bearing:

- **No layout class on the `[popover]` element.** An author `display` beats
  `[popover]:not(:popover-open) { display: none }`, and every closed sheet then renders and
  swallows the taps meant for the row beneath it.
- **`useDismissSwallowsTap`, in the capture phase.** Light dismiss closes on `pointerdown`
  and still delivers the `click` to whatever was underneath — that is how a dismissing tap
  once pressed "Import CSV".
- **Add its id to all four rule groups in `globals.css`** (base, `::backdrop`, and the two
  inside the anchored `@supports` block). The pattern is styled by id precisely so no shared
  class can grow a `display` later, and the cost of that is a third caller must opt in by
  hand.
- Phone gets the bottom sheet, desktop the anchored dropdown, and the nesting order of those
  gates stays as-is.

## Rejected alternatives

- **A dedicated `/items/scan` screen** owning the batch and all eight actions. More room and
  natural persistence, but it discards a design that shipped yesterday, creates a second
  selection concept, and duplicates the create-unknowns and label-hint work. Rejected once
  #109 was found to be already merged.
- **Inline controls in the selection bar**, matching `ReadinessControls`. Rejected on
  measured height: the bar already covers a phone viewport, and a signature picker cannot go
  in a row that is fighting for 4px.
- **Auto-clearing the batch after an action.** `ReadinessControls` already refuses to, because
  clearing unmounts the bar holding the outcome message. Here the argument is stronger: a
  150-item batch cost real physical effort, so an auto-clear after a mistap is
  unrecoverable.
- **Expiring a stale batch on a timer.** Rejected — see §1.

## Error handling

| Case | Behaviour |
| --- | --- |
| Any bulk write fails | One transaction, so it fully fails. Generic message to the client, stack logged server-side (§5). Batch untouched, retry available. |
| Some items retired | Excluded, counted, reported: *"Audited 47 · skipped 2 retired."* |
| Some items deleted meanwhile | Not matched by the id-scoped `where`, so simply not written. Folded into `skipped`. |
| Two technicians, overlapping batches | Safe by construction: every write is an id-scoped `updateMany` or `createMany({ skipDuplicates: true })`. |
| Signature id foreign or bogus | `getOwnedSignature` returns null → *"Select a valid signature."* Nothing written. |
| Selection at the 500 cap | Bar says so; the action refuses with a readable message rather than a Prisma error. |
| Session expired mid-sweep | The batch is in localStorage, so signing back in returns a full batch rather than an empty one. |
| Batch older than the current page data | Server re-checks status per write; a stale client row can cause a skip, never a wrong write. |

## Testing

**Pure — no DB, no jsdom**
- The `SelectedItem[]` ⇄ Map round trip in the persisted store, including a malformed or
  absent localStorage value parsing to an empty selection rather than throwing.

**DB**
- `recordAudits` — N audit rows share **one** `SignatureAsset`; `lastAuditedAt` equals the
  bound instant; retired excluded and counted in `skipped`; over-cap throws `TOO_MANY`.
- `upsertServiceRequests` — a `COMPLETED` row is wiped before re-upsert (the new-round reset
  regression the single-item tests already guard); a `PENDING` row's existing deadline
  survives a blank override; new rows created, existing updated, no duplicates.
- `completeServiceItems` — queue rows go `COMPLETED` and items get `markedReadyAt` in the
  **same** transaction; non-pending rows untouched; `dueAt` / `overdueAlertedAt` deliberately
  left on the finished row.

**Actions — the security-critical layer**
- Each of the three refuses without its capability, mirroring `readiness.test.ts` and
  `audit.test.ts`. The batch is client-supplied ids, so this is the whole boundary.
- `recordAuditsAction` refuses a signature id belonging to another admin.

**jsdom component**
- The selection survives a remount (persisted store rehydrates).
- The sheet's `[popover]` element carries no class and its content is a child — the same
  invariant `ItemSelectTable.test.tsx` pins for the `<dialog>`.

**Not testable here.** jsdom implements no Popover API, so opening, dismissal and
`useDismissSwallowsTap` are inert there; it has no layout engine, so nothing about the sheet
at 390px is proven; `npm run build` is evidence for neither. Verify in a real browser at both
widths, and the scan loop on a real iPhone through the cloudflared tunnel (the camera needs a
secure context).

**Run `npm test` before opening a PR.** CI now runs the suite as well — the `Tests (vitest)`
job added in `39f1a9b` (#112) stands up a real Postgres — so a green PR is finally evidence
the tests pass. Running locally first just avoids burning a CI cycle on something a local run
reports in seconds. The DB-backed tests need a quiet database: a concurrent session truncates
the shared test DB, which masquerades as flaky failures in unrelated files.

## Documentation, in the same commit

- **`CHANGELOG.md`** — new dated section, Added.
- **`docs/SECURITY.md`** — three new write paths and their gates. Bulk audit is a new
  `ADMINISTER`-gated write over client-supplied ids, and the signature is resolved
  server-side scoped to the acting admin; that belongs in the inventory. Bump *Last
  reviewed*. (#109 correctly needed no entry — it added no capability and no new gate. This
  does.)
- **`.claude/rules/backend-constraints.md`** — the bulk service-queue semantics (new-round
  reset and complete-stamps-`markedReadyAt`, both preserved in bulk), and the cross-cutting
  **retired excluded and reported, never refused** rule, noting it diverges from
  `markAuditedAction` on purpose.
- **`CLAUDE.md`** — one-line summary under Operational Readiness, so a reader who never opens
  the rule file still knows bulk audit exists.

## Risks

- **A persisted selection is invisible state.** Someone returns the next morning to 47
  selected items they no longer remember scanning. Mitigated by the started-at stamp in the
  bar, and by every action naming its count before it runs.
- **Bulk audit writes real accountability records.** 150 `ItemAudit` rows under one signature
  is exactly the point, but it is also the most consequential button in the app: it asserts
  someone laid eyes on 150 devices. The confirm step names the count and the signer.
- **The sheet is a third popover caller.** The four `globals.css` rule groups have no class to
  inherit from, so missing one gives a sheet that is subtly wrong only at one breakpoint.
- **Divergence from the single-item audit path.** Bulk skips retired, single-item refuses.
  Documented, but the two could drift further if someone later "fixes" one to match.
