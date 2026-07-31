# Search items by recipient name

**Date:** 2026-07-30
**Status:** Approved, not yet implemented

## Problem

A technician knows a person, not a serial. "SGT Doe is clearing — what does she
still have?" Today the only way to answer that on `/items` is to already know a
device name, make, model, or serial (`listItems`, `items.service.ts:288-296`).
The custody record that *does* hold the answer — the recipient named on each
hand receipt — is not reachable from item search at all.

## Goal

Typing a recipient's name into the `/items` search box returns every item that
person currently holds on an open hand receipt, and the table shows the holder
so the operator can see *why* each row matched.

## Non-goals

- **No change to the public home search** (`HomeSearch.tsx` / `liveSearchAction`).
  Adding a name mode there would let anyone past the shared PIN enumerate a
  soldier's equipment by name, which is a widening of a public-by-design surface
  and needs its own decision. Explicitly declined.
- **No historical custody search.** Only live custody; see §1.
- **No matching on `Item.currentUserEmail`.** That column holds unvalidated
  imported free text ("SGT Smith") and is *not* a signed custody record; mixing
  it into a custody search would blur the two. Explicitly declined.
- **No holder sort.** The Holder column is displayed but not sortable; see §4.
- **No change to `getHoldingTransfer` / `getLastReceiver`.** See §1.
- No change to authorization. `/items` is already behind `requireUser()`.

---

## 1. What "recipient" means

An item matches a recipient when it sits on a hand receipt that is **`status =
OPEN`** with **`TransferItem.returnedAt IS NULL`**.

That is the same rule `READINESS_CASE` already uses to decide `DEPLOYED`
(`readiness.sql.ts:44-52`). Reusing it is the point: the search results, the new
Holder column (§4) and the Readiness badge on the same row are then three
renderings of one fact and cannot disagree.

**This is deliberately not the `getHoldingTransfer` rule.** That function
(in `transfers.service.ts`) takes the *latest* receipt by `createdAt` and
returns null if that one is not `OPEN`, or if any of its rows are returned — it
fails closed because its value prefills a signed DA 2062, where naming the wrong
holder is worse than naming none. The two rules can diverge only when an item is
on an older open receipt *and* a newer closed one. Search and the Holder column
use the readiness rule so they agree with the badge beside them; the DA 2062
prefill keeps its stricter rule. **Do not "unify" these without deciding which
behaviour the receipt builder should get.**

### Consequences to accept

- **Closed receipts are purged 90 days after closing**, so this can only ever
  reflect live custody. There is no "who had this last year" answer to give.
- **An item assigned only through CSV/MDM import never matches**, because it was
  never hand-receipted. That is the `currentUserEmail` non-goal above.

## 2. Name matching — first, last, or both, in any order

`Transfer.receiverName` is a single free-text `String` (`schema.prisma:231`).
`Contact` stores `firstName`/`lastName` split, and autofill composes `"First
Last"` when filling a receipt (`schema.prisma:451-454`) — but the field is also
typed by hand, so live rows hold `"SGT Smith"`, `"Doe, Jane"`, and worse.

So the recipient branch **splits the trimmed query on whitespace and requires
every token to appear** (case-insensitive substring per token, AND'd):

| Query | vs. `"Jane Doe"` | Why |
|---|---|---|
| `doe` | match | single token, plain substring |
| `jane doe` | match | both tokens present |
| `doe jane` | **match** | tokens are AND'd, so order does not matter |
| `jane smith` | no match | `smith` absent |

A single-token query is therefore identical to a plain `contains`.

**Only the recipient branch tokenizes.** `deviceName`, `make`, `model` and
`serialNumber` keep matching the whole trimmed query as one pattern, so
searching `dell 5420` behaves exactly as it does today. Tokenizing those too
would change existing behaviour, which is out of scope.

**Cap: `MAX_RECIPIENT_TOKENS = 5`**, defined in `items.service.ts` beside the
filter helpers so both paths (§3) read the same constant and tokenize the query
through one shared function. Tokens beyond the fifth are dropped, so a
pasted paragraph cannot build an unbounded `AND` chain. Dropping (rather than
rejecting) keeps a fat-fingered paste returning *more* rows, never an error.

Empty tokens (from repeated whitespace) are discarded. A query that is entirely
whitespace is already handled upstream — `listItems` trims and treats blank as
"no search".

## 3. Backend — the filter is written twice, on purpose

`listItems` has **two** filter implementations, and
`items.readiness-sort.parity.test.ts` exists to stop them drifting:

- the Prisma `where` (`items.service.ts:287-300`), used for ordinary sorts;
- `itemFilterSql` (`items.service.ts:197-206`), the raw-SQL twin used whenever
  the sort involves a derived key (`readiness`, `auditState`).

The recipient clause lands in **both**, as a new branch of the existing search
`OR`.

### 3.1 Prisma path

A new element in the `OR` array:

```ts
{
  transferItems: {
    some: {
      returnedAt: null,
      line: { transfer: { status: "OPEN", AND: tokenClauses } },
    },
  },
}
```

where `tokenClauses` is
`tokens.map((t) => ({ receiverName: { contains: t, mode: "insensitive" } }))`.
`Item.transferItems` is the existing back-relation (`schema.prisma:134`).

### 3.2 Raw path

An `EXISTS` inside `itemFilterSql`'s search group, mirroring the one in
`READINESS_CASE`:

```sql
OR EXISTS (
  SELECT 1
  FROM "TransferItem" ti
  JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
  JOIN "Transfer" t ON t."id" = tl."transferId"
  WHERE ti."itemId" = i."id"
    AND ti."returnedAt" IS NULL
    AND t."status" = 'OPEN'
    AND <token AND-chain>
)
```

Token patterns are **bound parameters**, never interpolated (CLAUDE.md §2). With
no search term the token list is empty and the chain renders as `FALSE`; the
existing `${pattern}::text IS NULL OR …` guard already short-circuits the whole
group in that case, so one statement still serves every filter combination.

The escaping rule follows the surrounding code: `itemFilterSql` deliberately
does **not** escape LIKE metacharacters, because the Prisma `contains` it stands
in for does not either, and the two paths matching each other matters more than
tightening one of them. The recipient branch keeps that convention on both sides.

### 3.3 Index + migration

`Transfer.receiverName` gets a **pg_trgm GIN index**:

```prisma
@@index([receiverName(ops: raw("gin_trgm_ops"))], type: Gin, map: "Transfer_receiverName_trgm_idx")
```

The match is `ILIKE '%tok%'` — a leading wildcard no B-tree can serve. Same
shape and reasoning as `Item_serialNumber_trgm_idx` (`schema.prisma:164-166`).
`pg_trgm` is already installed. Note `receiverName` is a plain `String`, not
`citext`, so it needs no `::text` cast — that cast exists on `serialNumber`
purely because citext's own `ILIKE` operator cannot use a text trigram index.

**Migration:** authored with `prisma migrate diff --from-config-datasource
--to-schema --script` and applied with `migrate deploy` (`migrate dev` cannot
run non-interactively in this shell). **Applied to Supabase before the PR
merges**, per migrate-before-push — a bare `next build` never runs
`migrate deploy`.

Tokens shorter than 3 characters cannot use a trigram index effectively and fall
back to a scan. Accepted: `Transfer` is small (receipts, purged 90 days after
close) and orders of magnitude below `Item`.

### 3.4 Security posture

No watched file changes, so the `Security docs current` CI job does not fire and
`docs/SECURITY.md` needs no edit:

- `sort-keys.ts` is untouched — no sort key is added (§4).
- `admin/actions/readiness.ts` is untouched.
- `items.service.ts` is deliberately **not** on the watch list
  (`check-security-docs.mjs:77-83`).

No authorization change: `/items` already requires a session, and recipient
names are visible today on the public item and receipt pages, so this exposes no
data a signed-in user could not already reach.

## 4. The Holder column

Without it, a search for `doe` returns rows with nothing on screen explaining
the match. `/items` has no holder column today (`ITEM_COLUMNS`,
`items-view.ts:49-59`).

### 4.1 Fetching it

New `holdersForItems(ids: string[]): Promise<Map<string, string>>` in
`src/modules/transfers/holders.query.ts` — **one** query for the whole page,
never one per row, mirroring `readinessForItems` (`readiness.query.ts:21-33`):

```sql
SELECT DISTINCT ON (ti."itemId") ti."itemId" AS "itemId", t."receiverName" AS "receiverName"
FROM "TransferItem" ti
JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
JOIN "Transfer" t ON t."id" = tl."transferId"
WHERE ti."itemId" IN (…)
  AND ti."returnedAt" IS NULL
  AND t."status" = 'OPEN'
ORDER BY ti."itemId", t."createdAt" DESC
```

`DISTINCT ON` picks the most recent open receipt if an item somehow sits on two,
so the column shows one name rather than fanning the row out. Ids are bound via
`Prisma.join`. Bounded by the caller (a page of items). An id with no open
receipt is simply absent from the map.

`/items/page.tsx` calls it after `listItems` (it needs the page's ids), next to
the existing `readinessForItems` call — two derivation queries per page load,
both bounded by `ITEMS_PAGE_SIZE`.

### 4.2 Rendering it

- `ItemRow` gains `holderName: string | null` (`items-view.ts`).
- `ITEM_COLUMNS` gains `{ key: "holder", label: "Holder" }`, positioned after
  `serialNumber` and before `deviceUIC`.
- Visible by default, toggleable like every other column. Existing users' stored
  hidden-column lists do not contain `holder`, so it appears for them too.
- No open receipt renders as `—`.

### 4.3 Sortability

`SORTABLE_COLUMNS` is currently an alias of `ITEM_COLUMNS`
(`items-view.ts:64`), on the stated invariant that every displayed column is
server-sortable. `holder` is the first exception, so:

- `SORTABLE_COLUMNS` becomes `ITEM_COLUMNS.filter((c) => c.key !== "holder")`.
- The comment above it is updated to record *why* — the file currently documents
  the opposite, and leaving that stale is exactly the trap CLAUDE.md's
  documentation rule exists to prevent.
- `ColumnKey` and `SortField` stop being the same union.

Sorting by holder would mean a third `DERIVED_SORT_KEY` with a scalar subquery,
its own parity coverage, and a NULLs-behaviour decision. Deliberately deferred;
it is a clean follow-up if operators ask for it.

## 5. UI copy

`ItemsSearchInput` placeholder (`ItemsSearchInput.tsx:78`) becomes:

> `Search device name, make, model, serial number, or recipient`

No change to the debounce, the URL round-trip, or `aria-label`.

## 6. Testing

**`items.service.search.test.ts`** — extend:

- an item on an open receipt to "Jane Doe" matches `doe`, `jane`, `jane doe`;
- and matches `doe jane` (token order independence — the §2 requirement);
- does **not** match `jane smith`;
- an item whose `TransferItem.returnedAt` is set does **not** match;
- an item whose only receipt is `CLOSED` does **not** match;
- an existing device-field search returns exactly what it does today
  (`dell 5420` is not tokenized).

**`items.readiness-sort.parity.test.ts`** — add a recipient-name filter case, so
both filter implementations must return the same ids in the same order for a
name query. This is the test that catches a change made to one path and not the
other.

**New `holders.query.test.ts`** — the map is keyed by item id; a returned row and
a closed receipt both yield no entry; an item on two open receipts yields the
newer one.

Integration tests hit a real Postgres, so the trigram migration must be applied
to the test DB before they run. Note the shared-test-DB hazard: two agents
running the suite concurrently truncate each other.

## 7. Documentation (same commit as the code)

- **`CHANGELOG.md`** — new `## 2026-07-30` section (or add to today's), under
  **Added**: item search now matches the recipient named on an open hand
  receipt, and `/items` shows a Holder column. Under **Notes**: the new index
  migration must be applied to Supabase before deploy.
- **`CLAUDE.md`** — in the Data Fetching section, extend the note about the two
  `/items` filter implementations to record that the filter now spans a relation
  (`Item → TransferItem → TransferLine → Transfer`), and that the custody rule it
  uses is the readiness one, not `getHoldingTransfer`'s.
- **`docs/SECURITY.md`** — no change required (§3.4).

## 8. Risks

| Risk | Mitigation |
|---|---|
| The two filter paths drift | The parity test gains a recipient case (§6) |
| The `EXISTS` slows the list query | Trigram index (§3.3); `Transfer` is small and purged |
| Holder column reintroduces an N+1 | One batched query, same shape as `readinessForItems` (§4.1) |
| Operators read the Holder column as "assigned user" | It shows only signed open-receipt custody; `currentUserEmail` is a separate, already-visible field on the item page |
