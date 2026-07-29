# Automated MDM CSV import + bulk unit management

**Date:** 2026-07-29
**Status:** Design — approved, not yet implemented

## Problem

Inventory is refreshed today by an admin opening `/admin/items/import`, choosing an
Intune export, resolving any unrecognised unit abbreviations, and committing. That
works, but it only happens when somebody remembers to do it, and the fleet drifts
between runs.

A technician can automate the Intune export on a nightly schedule. We want that
export to reach the app without a human in the loop — and, because removing the
human also removes the person who teaches new unit abbreviations, we need a place
for an admin to manage the unit vocabulary in bulk.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Push or pull? | **Push** — his scheduled task POSTs to us | Any pull needs somewhere to park the file. Every free option (SharePoint, a git repo) adds a middleman that can go stale; Azure Blob costs money, which is off the table. If his job can write a file it can make an HTTPS POST. |
| Credential | **One shared secret in an env var**, constant-time compare | A single machine-owned job. Matches what `/api/cron/purge` already does. |
| Unresolved units block the import? | **No** | They already don't — see "Unresolved units" below. |
| Rename a unit → existing items? | **Backfill them** | `Item.homeUnit` is a denormalised copy of `Unit.fullName`. Leaving it stale splits one unit into two entries in the `/items` filter and two bars in the analytics leaderboard. |
| Stream the upload? | **No** | The timeout risk is DB round trips inside the transaction, not transfer time. Already fixed by batching; see "Duration budget". |

### Rejected alternatives

- **`ApiKey` table + `/admin/api-keys`** (hashed keys, per-owner, expiry, revocation,
  last-used). Designed in full, then dropped: it is the right shape for keys on
  several technicians' laptops, and overbuilt for one automated job the org owns.
  Revisit if a second consumer appears — the schema from that design still applies.
- **Nightly pull from Azure Blob via a read-only SAS URL.** Cleanest version of pull;
  ruled out by cost, however small.
- **Pull from the Intune Graph API directly.** Needs an app registration,
  `DeviceManagementManagedDevices.Read.All`, admin consent and a rotating client
  secret, plus a new Graph→`RawRow` mapping layer that would re-derive everything
  `csv.ts`'s header aliases already encode.
- **Private GitHub repo as the drop location.** Free, and the cron already runs in
  Actions — but serial numbers and assigned-user names would live in permanent git
  history, which contradicts the app's 90-day receipt purge.

## Architecture

```
his scheduled task (nightly)
  export from Intune
  -> POST /api/items/import
       Authorization: Bearer $MDM_IMPORT_SECRET
       multipart/form-data; file=<csv>
  -> requireImportSecret(req)      [constant-time, fails closed]
  -> parseItemsCsv(text)           [unchanged]
  -> commitImport(text, name, [], serviceAccount)   [unchanged logic]
  -> 200 { added, updated, unchanged, skipped, unresolved }
```

Nothing about the import *logic* changes. The new route is a second front door onto
`commitImport`; the browser page at `/admin/items/import` stays exactly as it is.

### Unresolved units

Worth stating plainly, because it shaped the whole design. "Unresolved" does **not**
mean rejected, and does not concern `deviceUIC` (which imports verbatim). It fires
only for a row with no `homeUnit` value but a `deviceName`: the importer tries to
decode the device name into a known abbreviation (`detectHomeUnit`, `import.ts:190`),
and if no segment matches, the row is added to `unresolved` — and then
`toCreate.push(item)` runs anyway (`import.ts:198`).

So an empty `resolutions` array is a valid call. Rows import; unrecognised ones land
with `homeUnit` blank. The browser's resolution step is an opportunity to *teach*,
not a gate, and `learnUnits` makes teaching permanent — once per abbreviation, ever.

## Components

### 1. `src/lib/cron-auth.ts` (new)

Extract the constant-time bearer check currently inline in
`src/app/api/cron/purge/route.ts:16` so both routes share one implementation.
Two independent copies of an auth check drift, and the copy is the one that doesn't
get fixed.

```ts
export function hasValidBearerSecret(req: Request, secret: string | undefined): boolean
```

Fails closed when the secret is unset. `purge/route.ts` is refactored to call it —
behaviour-identical, covered by existing tests.

Goes on the `check-security-docs` watch list.

### 2. `src/app/api/items/import/route.ts` (new)

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
```

POST only. Reads `Authorization: Bearer <secret>` against `MDM_IMPORT_SECRET`;
401 on failure, with no detail. Accepts `multipart/form-data` with a `file` field,
rejecting a non-`.csv` name and an oversized body before parsing. Then
`commitImport(text, file.name, [], serviceAccount)`, `revalidatePath("/items")` and
`/admin/audit`, and a JSON summary.

Errors return generic messages with detail logged server-side, per the app's error
handling rule.

### 3. Service account

`commitImport` requires `editor: { id, name }` and writes `ImportBatch.createdById`,
a required FK to `User`. A cron run has no session.

Seed a **non-loginable service account** — name "MDM Import (automated)", a password
hash no input can produce, `role: USER` (it never passes through `requireAdmin`;
the route authenticates by secret). It exists only as an attribution anchor.

This is a deliberate exception to the "individual account per technician, no shared
logins" rule in `CLAUDE.md`. That rule protects human accountability; this account
cannot sign in and represents a machine. It must be documented as such rather than
introduced quietly.

Note `ImportBatch.createdById` is `ON DELETE RESTRICT` and the account-purge worker
checks for it (`account-purge.ts:28-31`), so the service account can never be
silently hard-deleted out from under the import history.

### 4. `commitImport` returns `unresolved`

Currently returns `{ added, updated, skipped, unchanged, detected, mismatches }`.
`plan.unresolved` is already in scope (`items.service.ts:701`). Add it to the return
so the route can report unresolved rows without parsing the CSV a second time.
Purely additive; the browser flow ignores the new field.

### 5. `/admin/units` — bulk unit management (new)

Mirrors `/admin/categories`, the existing managed-vocabulary page.

**View.** Table of abbreviation, full name, in-use count (items whose `homeUnit`
equals that full name), created date.

**Single add.** Abbreviation + full name.

**Bulk add/modify.** Paste a block of `ABBREV,Full Name` lines. Preview shows
new / changed / unchanged counts and, for each change, how many items would be
backfilled. Apply commits.

**Rename semantics.** Changing a unit's `fullName` rewrites every `Item.homeUnit`
holding the old value in one `updateMany`, with the affected count shown before
applying. This requires adding `homeUnit` to the `ItemEdit` logged-field set — it
is not there today, so a mass change would otherwise leave no history.

**Delete.** Refused while any item still carries the name, mirroring categories.
The item would otherwise hold a value that appears in no picker.

**Unresolved surfacing.** The page shows what the most recent import could not
resolve, so the nightly run has somewhere to report and the admin has one place to
act. This closes the loop the removal of the human opened.

### 6. `learnUnits` rewrite

`units.service.ts:21-31` is a `for` loop of `prisma.unit.upsert` — one query per
row, the pattern `CLAUDE.md` bans. Rewrite as batched queries in a single
transaction, shaped like `setItemsCategory`: one `findMany` for current values, one
`createMany({ skipDuplicates: true })` for new abbreviations, batched updates for
changed names. Same uppercase normalisation, same upsert semantics.

### 7. Staleness signal

With nobody in the loop, a dead scheduled task looks exactly like a fleet that
stopped changing, and would go unnoticed for weeks. Surface the most recent
successful import's timestamp to admins (`ImportBatch.createdAt`, already stored —
no new column).

## Duration budget

The import already hit real timeouts and was already fixed; the new route must not
reintroduce the failure by omission.

`commitImport`'s transaction is explicitly sized (`items.service.ts:855-865`):

```ts
timeout: 50_000,
maxWait:  5_000,
```

`maxWait` and `timeout` are consumed **sequentially**, so their sum (55s) must stay
under the calling surface's `maxDuration`. `/admin/items/import` sets 60.

**A route handler that declares no `maxDuration` gets the platform default**, and a
55s transaction budget would then outlive the function — killed mid-transaction
rather than aborting cleanly into the caught generic error. So:

- The route sets `maxDuration = 300` (the Hobby ceiling). A nightly job has nobody
  waiting on it, so it can afford five times the margin the interactive page can
  justify.
- Verify during implementation whether the transaction budget should rise to match.
  Keep the sum under `maxDuration` with headroom, and keep that invariant written
  down next to both numbers.
- **Measure a full 2000-row run and record the number** rather than reasoning about
  it. This also informs the "chunking large imports" follow-up the code notes as
  deferred (`items.service.ts:862`).

Streaming the request body was considered and rejected: the payload is ~500 KB at
the 2000-row cap, and the cost is DB round trips inside the transaction, which
batching already addressed. Streaming would require moving `parseItemsCsv` and
`commitImport` off `csv-parse/sync` — a refactor of the most heavily tested code in
the import path, optimising something that is not slow.

## Data model

```prisma
model Unit {
  id           String   @id @default(cuid())
  abbreviation String   @unique @db.Citext   // CHANGED: was plain String
  fullName     String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

`abbreviation` becomes citext. It is `@unique` today but case-sensitive, so the
uppercase normalisation in `learnUnits` is convention-only — a write site that
forgets creates `wabc01` alongside `WABC01`. Same reasoning that made `User.email`
and `Item.serialNumber` citext. The extension is already enabled.

No other schema changes. No `ApiKey` table.

### Migration

- Citext conversion on `Unit.abbreviation`, plus the service-account seed.
- `prisma migrate dev` cannot run non-interactively in this shell: author via
  `migrate diff --from-config-datasource --to-schema`, then `migrate deploy`.
- Apply to Supabase **before** the merge deploys (migrate-before-push).
- The new rows inherit RLS-enabled via the `rls_auto_enable` trigger with no
  policy — deny-all to `anon`, which is correct and needs no action.

## Environment

| Var | Where | Notes |
| --- | --- | --- |
| `MDM_IMPORT_SECRET` | Vercel + the technician's scheduled task | New. Rotating requires a redeploy — an accepted tradeoff of the shared-secret shape. |

## Testing

- **Unit:** `hasValidBearerSecret` — missing header, wrong secret, unset secret
  (must fail closed), length mismatch, exact match.
- **Unit:** batched `learnUnits` — new, changed, unchanged, mixed case.
- **Unit:** rename backfill planning — affected-count calculation.
- **Integration:** POST a CSV with a valid secret; assert rows land and
  `ImportBatch.createdById` is the service account. POST with a bad secret; assert
  401 and nothing written.
- **Integration:** rename a unit; assert `Item.homeUnit` backfilled and `ItemEdit`
  rows written.
- **Measurement:** full 2000-row import, timed, number recorded in the PR.

Note: parallel agents share one test database and truncate each other — the suite
must not be run concurrently.

## Documentation (same commit — CI-enforced)

- `docs/SECURITY.md` — new entry for the secret-authenticated import endpoint: what
  it authenticates, that it fails closed, the service account and why it exists, the
  rotation-needs-redeploy tradeoff. Bump *Last reviewed*.
- `scripts/check-security-docs.mjs` — add `src/lib/cron-auth.ts` and the new route to
  `WATCHED`, or they escape the guardrail silently.
- `CHANGELOG.md` — entry under `2026-07-29`: Added (automated import, `/admin/units`),
  Changed (`learnUnits` batching, `homeUnit` now logged to history), Security (new
  endpoint + secret), Notes (migration, `MDM_IMPORT_SECRET`).
- `CLAUDE.md` — record the import-only scope, that empty `resolutions` is valid, the
  `maxDuration` ≥ transaction-budget invariant, and the service-account exception to
  the no-shared-logins rule.

## Risks and open questions

1. **Rotation requires a redeploy.** Accepted for a single machine-owned secret. If
   more consumers appear, the rejected `ApiKey` design is the upgrade path.
2. **Anyone holding the secret can write inventory.** Blast radius is bounded by the
   2000-row cap; every change lands in `ItemEdit` attributed to the service account,
   so it is traceable. It cannot reach users, receipts, returns or the queue.
3. **Vercel's request-body size limit** (believed ~4.5 MB) — confirm before relying
   on it. A 2000-row CSV is well under, but the technician should know the row cap
   exists and split larger exports.
4. **Transaction budget vs. `maxDuration = 300`** — decide after measurement.
5. **Rate limiting** — the route is secret-guarded and machine-driven; `/api/cron/purge`
   is not limited either. Decide during implementation whether a scope on the
   existing limiter is warranted, on volume grounds rather than auth grounds. Any
   limit must not refund on success (volume is the cost, per the
   `requestPasswordResetAction` precedent).

## Out of scope

- Any pull/fetch mechanism (Graph, SharePoint, blob storage).
- The `ApiKey` table, `/admin/api-keys`, and per-person key attribution.
- Chunking `commitImport` across multiple transactions — still the deferred
  follow-up it is today, informed by the measurement above.
- Changes to `/admin/items/import`, which keeps its interactive two-step flow.
