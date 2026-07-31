# Search Items by Recipient Name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing a recipient's name into the `/items` search box returns every item that person currently holds on an open hand receipt, and the table shows a Holder column so the match is visible.

**Architecture:** `listItems` filters through **two** implementations that a parity test forces to agree — a Prisma `where` and a raw-SQL twin (`itemFilterSql`) used when the sort involves a derived key. The recipient clause is added to both, sharing one tokenizer so they cannot disagree about what a multi-word query means. The Holder column is fetched by one batched query per page, in the shape of the existing `readinessForItems`.

**Tech Stack:** Next.js 16 (App Router, RSC), Prisma 7 over PostgreSQL, `pg_trgm` GIN indexes, Vitest (unit + integration against a real Postgres).

**Spec:** `docs/superpowers/specs/2026-07-30-search-items-by-recipient-name-design.md`

## Global Constraints

- **Custody rule, verbatim, everywhere:** an item is held by a recipient when it sits on a `TransferItem` with `returnedAt IS NULL` whose `Transfer` has `status = 'OPEN'`. Same rule as `READINESS_CASE` in `src/modules/items/readiness.sql.ts:44-52`. Do **not** use `getHoldingTransfer`'s stricter latest-receipt rule, and do not change that function.
- **Never concatenate or interpolate a value into SQL** (CLAUDE.md §2). Every pattern is a bound parameter. Only SQL *identifiers* from a frozen allowlist may ever be spliced, and this feature splices none.
- **No query inside a loop or `.map`.** The Holder column is one batched query for the whole page.
- **`MAX_RECIPIENT_TOKENS = 5`** — tokens beyond the fifth are dropped, never rejected.
- **Only the recipient branch tokenizes.** `deviceName`/`make`/`model`/`serialNumber` keep matching the whole trimmed query as one pattern. Do not change their behavior.
- **Placeholder copy, exactly:** `Search device name, make, model, serial number, or recipient`
- **Column label, exactly:** `Holder`
- **Do not modify** `src/modules/items/sort-keys.ts` or `src/app/admin/actions/readiness.ts`. Both are on the `check-security-docs` watch list; touching either forces a `docs/SECURITY.md` edit and this feature needs none.
- **Docs ship in the same commit as the code** (CLAUDE.md, non-negotiable).
- **Test DB hazard:** two agents running the suite concurrently `TRUNCATE` each other. Run integration tests alone.

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/items/recipient-search.ts` | **New.** Pure leaf module: `MAX_RECIPIENT_TOKENS` + `recipientTokens()`. No imports, so both query paths and a client-safe test can use it. |
| `src/modules/items/recipient-search.test.ts` | **New.** Unit tests for the tokenizer. |
| `src/modules/items/items.service.ts` | **Modify.** Add the recipient branch to the Prisma `where` and to `itemFilterSql`. |
| `src/modules/items/items.service.search.test.ts` | **Modify.** Assert the shape of both new clauses. |
| `src/modules/items/items.readiness-sort.parity.test.ts` | **Modify.** Add recipient filter cases + real-row exclusion tests. |
| `prisma/schema.prisma` | **Modify.** Trigram GIN index on `Transfer.receiverName`. |
| `prisma/migrations/<ts>_transfer_receiver_name_trgm/migration.sql` | **New.** The `CREATE INDEX`. |
| `src/modules/transfers/holders.query.ts` | **New.** `holdersForItems(ids)` — one batched query, returns a `Map`. |
| `src/modules/transfers/holders.query.test.ts` | **New.** Integration tests against real rows. |
| `src/components/items-view.ts` | **Modify.** `ColumnKey` gains `"holder"`, `ItemRow` gains `holderName`, `SORTABLE_COLUMNS` stops aliasing `ITEM_COLUMNS`. |
| `src/components/ItemSelectTable.tsx` | **Modify.** Render the Holder cell. |
| `src/app/items/page.tsx` | **Modify.** Call `holdersForItems`, pass `holderName`. |
| `src/app/items/ItemsSearchInput.tsx` | **Modify.** Placeholder copy. |
| `CHANGELOG.md`, `CLAUDE.md` | **Modify.** Same commits as the code. |

---

### Task 1: The name tokenizer

Splits a search query into name tokens. A pure leaf module with **no imports** — `items.service.ts` is `server-only` and pulls in Prisma, so keeping the tokenizer separate lets a plain unit test (and, later, any client code) read it without booting a DB client. Same reasoning as `sort-keys.ts`.

**Files:**
- Create: `src/modules/items/recipient-search.ts`
- Test: `src/modules/items/recipient-search.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_RECIPIENT_TOKENS: number` (= 5) and `recipientTokens(search: string): string[]`. Task 2 calls `recipientTokens` from both query paths.

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/recipient-search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recipientTokens, MAX_RECIPIENT_TOKENS } from "./recipient-search";

describe("recipientTokens", () => {
  it("returns a single token unchanged, so a one-word query is a plain contains", () => {
    expect(recipientTokens("doe")).toEqual(["doe"]);
  });

  it("splits a full name into its parts", () => {
    expect(recipientTokens("jane doe")).toEqual(["jane", "doe"]);
  });

  // The tokens are AND'd by the caller, so the ORDER they come back in does not
  // matter to matching — but they must all be present. This is what makes
  // "doe jane" find "Jane Doe": the requirement is set membership, not sequence.
  it("keeps every token when the name is typed surname-first", () => {
    expect(recipientTokens("doe jane").sort()).toEqual(["doe", "jane"]);
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(recipientTokens("  jane   doe \t")).toEqual(["jane", "doe"]);
  });

  it("returns nothing for a blank or whitespace-only query", () => {
    expect(recipientTokens("")).toEqual([]);
    expect(recipientTokens("   ")).toEqual([]);
  });

  // A pasted paragraph must not build an unbounded AND chain. Dropping the
  // surplus (rather than erroring) keeps a fat-fingered paste returning MORE
  // rows, never a failure.
  it("caps the token count, keeping the first MAX_RECIPIENT_TOKENS", () => {
    expect(MAX_RECIPIENT_TOKENS).toBe(5);
    expect(recipientTokens("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```
npx vitest run src/modules/items/recipient-search.test.ts
```

Expected: FAIL — `Failed to resolve import "./recipient-search"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/items/recipient-search.ts`:

```ts
/**
 * Splitting a recipient search into name tokens.
 *
 * A LEAF module with no imports, for the same reason sort-keys.ts is one:
 * items.service.ts is `server-only` and pulls in Prisma, and this vocabulary is
 * needed by BOTH of listItems' filter implementations (the Prisma `where` and
 * the raw-SQL `itemFilterSql`). One definition is what stops the two paths
 * disagreeing about what a multi-word query means.
 *
 * WHY TOKENS AT ALL: `Transfer.receiverName` is a single free-text String —
 * Contact stores firstName/lastName split and autofill composes "First Last",
 * but operators also type "SGT Smith" and "Doe, Jane". A plain substring match
 * finds "jane", "doe" and "jane doe" against "Jane Doe" but NOT "doe jane".
 * Requiring every token to appear (the caller ANDs them) makes the match
 * order-independent, so first name, last name, or both — in any order — work.
 *
 * Only the RECIPIENT branch tokenizes. deviceName/make/model/serialNumber keep
 * matching the whole trimmed query as one pattern, so `dell 5420` behaves
 * exactly as it always has.
 */

/** Hard cap on tokens in one query.
 *
 *  A pasted paragraph would otherwise build an unbounded AND chain, and every
 *  token costs an index probe on both paths. Surplus tokens are DROPPED rather
 *  than rejected: a fat-fingered paste should return more rows than intended,
 *  never an error in a type-ahead. */
export const MAX_RECIPIENT_TOKENS = 5;

/** Whitespace-separated name tokens, trimmed, empties removed, capped.
 *  A single-token query yields one token, so it behaves as a plain `contains`. */
export function recipientTokens(search: string): string[] {
  return search
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "")
    .slice(0, MAX_RECIPIENT_TOKENS);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```
npx vitest run src/modules/items/recipient-search.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/recipient-search.ts src/modules/items/recipient-search.test.ts
git commit -m "feat(items): add the recipient-name tokenizer"
```

---

### Task 2: Match the recipient in BOTH filter paths

The two filter implementations must change **together**. Changing only one leaves `items.readiness-sort.parity.test.ts` failing, and a reviewer could not sensibly approve half — so the Prisma branch, the raw-SQL branch, their unit tests, the parity cases and the CLAUDE.md note are one task.

**Files:**
- Modify: `src/modules/items/items.service.ts` (`itemFilterSql` at :197-206, the `where` builder at :287-300)
- Modify: `src/modules/items/items.service.search.test.ts`
- Modify: `src/modules/items/items.readiness-sort.parity.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `recipientTokens`, `MAX_RECIPIENT_TOKENS` from Task 1.
- Produces: no new exports. `listItems(opts)` keeps its exact signature and return type; only which rows it matches changes.

- [ ] **Step 1: Loosen the test helper's type so a non-`contains` branch can be inspected**

The existing helper types every `OR` branch as a `contains` clause; the recipient branch is a relation filter and will not fit. In `src/modules/items/items.service.search.test.ts`, replace the `whereOf` declaration at the top of `describe("listItems", …)` (lines 16-18):

```ts
  // Branches are no longer uniform: four are `contains` clauses on Item columns
  // and one is a relation filter over the item's open hand receipts. Typed
  // loosely here, with `containsOf` narrowing the column branches at each use.
  type SearchBranch = Record<string, unknown>;
  const whereOf = () => vi.mocked(prisma.item.findMany).mock.calls[0][0]?.where as
    | { OR: SearchBranch[] }
    | undefined;
  const containsOf = (branch: SearchBranch, field: string) =>
    branch[field] as { contains: string; mode: string };
```

Then fix the two existing readers:

- line 28-29 becomes
  ```ts
    const deviceName = containsOf(whereOf()!.OR.find((c) => "deviceName" in c)!, "deviceName");
    expect(deviceName).toEqual({ contains: "Edge Rou", mode: "insensitive" });
  ```
- line 34 becomes
  ```ts
    expect(containsOf(whereOf()!.OR[0], "deviceName").contains).toBe("router");
  ```

- [ ] **Step 2: Write the failing tests**

In the same file, update the first test (line 20-24) to expect the new branch, and add two new ones after it:

```ts
  it("searches device name alongside make, model, serial and the open-receipt recipient", async () => {
    await listItems({ search: "router" });
    const fields = whereOf()!.OR.map((c) => Object.keys(c)[0]);
    expect(fields).toEqual(["deviceName", "make", "model", "serialNumber", "transferItems"]);
  });

  it("matches the recipient only on an OPEN, unreturned receipt, one AND clause per token", async () => {
    await listItems({ search: "doe jane" });
    const branch = whereOf()!.OR.find((c) => "transferItems" in c)!.transferItems as {
      some: {
        returnedAt: null;
        line: { transfer: { status: string; AND: { receiverName: { contains: string; mode: string } }[] } };
      };
    };
    // The custody rule, asserted field by field: a returned row or a closed
    // receipt is NOT custody, and dropping either guard would quietly turn this
    // into a search of every receipt that ever existed.
    expect(branch.some.returnedAt).toBeNull();
    expect(branch.some.line.transfer.status).toBe("OPEN");
    expect(branch.some.line.transfer.AND).toEqual([
      { receiverName: { contains: "doe", mode: "insensitive" } },
      { receiverName: { contains: "jane", mode: "insensitive" } },
    ]);
  });

  it("emits the recipient EXISTS with one BOUND pattern per token on the raw path", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ search: "doe jane", sort: "readiness", dir: "asc" });
    const arg = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(arg.sql).toMatch(/EXISTS/);
    expect(arg.sql).toMatch(/"returnedAt" IS NULL/);
    // Patterns are parameters, never spliced text (CLAUDE.md §2).
    expect(arg.sql).not.toMatch(/ILIKE\s+'%/);
    expect(arg.values).toContain("%doe%");
    expect(arg.values).toContain("%jane%");
  });
```

- [ ] **Step 3: Run them and watch them fail**

```
npx vitest run src/modules/items/items.service.search.test.ts
```

Expected: FAIL — the field list is `["deviceName","make","model","serialNumber"]` with no `transferItems`, `.find((c) => "transferItems" in c)` is `undefined`, and `arg.values` has no `%doe%`.

- [ ] **Step 4: Add the Prisma branch**

In `src/modules/items/items.service.ts`, add the import beside the existing ones (after line 16):

```ts
import { recipientTokens } from "./recipient-search";
```

Then replace the `if (search) { … }` block inside `listItems` (lines 288-297) with:

```ts
  if (search) {
    // `search` is trimmed and non-empty here, so this yields at least one token.
    const tokens = recipientTokens(search);
    filters.push({
      OR: [
        { deviceName: { contains: search, mode: "insensitive" } },
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { serialNumber: { contains: search, mode: "insensitive" } },
        // The recipient named on the item's CURRENT custody — an open receipt
        // with this row unreturned. Same rule as READINESS_CASE's DEPLOYED
        // branch, deliberately NOT getHoldingTransfer's stricter
        // latest-receipt-only rule: this must agree with the Readiness badge
        // and the Holder column rendered on the same row.
        //
        // Tokens are AND'd, so "doe jane" finds "Jane Doe" — see
        // recipient-search.ts. Whatever changes here changes in itemFilterSql
        // too, or items.readiness-sort.parity.test.ts fails.
        {
          transferItems: {
            some: {
              returnedAt: null,
              line: {
                transfer: {
                  status: "OPEN",
                  AND: tokens.map((t) => ({
                    receiverName: { contains: t, mode: "insensitive" as const },
                  })),
                },
              },
            },
          },
        },
      ],
    });
  }
```

- [ ] **Step 5: Add the raw-SQL branch**

In the same file, immediately **above** `itemFilterSql` (before line 197), add:

```ts
/** The recipient half of the search filter, as SQL.
 *
 *  The EXISTS mirrors the one in READINESS_CASE (readiness.sql.ts) — same three
 *  joins, same two custody guards — so "held by" means one thing across the
 *  filter, the Readiness badge and the Holder column. An EXISTS rather than a
 *  join so an item on two receipts still counts once and cannot duplicate a row.
 *
 *  Tokens are AND'd (see recipient-search.ts) and every pattern is a BOUND
 *  parameter (CLAUDE.md §2). With no tokens the branch renders as FALSE; the
 *  caller's `${pattern}::text IS NULL OR …` guard has already short-circuited
 *  the whole group in that case, so this is belt-and-braces rather than a path
 *  anything reaches. */
function recipientMatchSql(tokens: string[]): Prisma.Sql {
  if (tokens.length === 0) return Prisma.sql`FALSE`;
  const clauses = tokens.map((t) => Prisma.sql`t."receiverName" ILIKE ${`%${t}%`}`);
  return Prisma.sql`EXISTS (
      SELECT 1
      FROM "TransferItem" ti
      JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
      JOIN "Transfer" t ON t."id" = tl."transferId"
      WHERE ti."itemId" = i."id"
        AND ti."returnedAt" IS NULL
        AND t."status" = 'OPEN'
        AND ${Prisma.join(clauses, " AND ")}
    )`;
}
```

Then add the branch to `itemFilterSql`'s search group — the body becomes:

```ts
function itemFilterSql(search: string | null, uic: string | null): Prisma.Sql {
  const pattern = search ? `%${search}%` : null;
  return Prisma.sql`
    (${pattern}::text IS NULL
      OR i."deviceName" ILIKE ${pattern}::text
      OR i."make" ILIKE ${pattern}::text
      OR i."model" ILIKE ${pattern}::text
      OR i."serialNumber"::text ILIKE ${pattern}::text
      OR ${recipientMatchSql(search ? recipientTokens(search) : [])})
    AND (${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)`;
}
```

Also extend that function's existing docblock with a line recording the new branch:

```
 *  The recipient branch is an EXISTS over open hand receipts (recipientMatchSql)
 *  — the filter now spans a relation, so the Prisma twin above is a nested
 *  `some`, not another column `contains`. Both must change together.
```

- [ ] **Step 6: Run the unit tests and watch them pass**

```
npx vitest run src/modules/items/items.service.search.test.ts
```

Expected: PASS, all tests including the three new/updated ones.

- [ ] **Step 7: Add the parity cases — seeds with real recipients**

In `src/modules/items/items.readiness-sort.parity.test.ts`, extend the `Seed` type (after `onOpenReceipt?: boolean;` at line 41):

```ts
  /** The name on the seeded receipt. Only meaningful with `onOpenReceipt`. */
  receiverName?: string;
  /** Seed the receipt as CLOSED — custody has ended, so it must NOT match. */
  receiptClosed?: boolean;
  /** Seed the row as returned — custody has ended, so it must NOT match. */
  receiptReturned?: boolean;
```

Give the three existing receipt-bearing seeds real names — in `SEEDS`, add `receiverName:` to the entries for `03`, `09` and `12`:

```ts
  { serial: `${PREFIX}03`, make: "HP", model: "Delta-9", deviceName: null, uic: "W2BBBB", category: "Switch", lastAuditedAt: JUN, onOpenReceipt: true, receiverName: "Jane Doe", expected: "DEPLOYED" },
  … 
  { serial: `${PREFIX}09`, make: "Zebra", model: "ZT", deviceName: "Node nine", uic: "W1AAAA", category: "Printer", lastAuditedAt: JAN, flagged: true, onOpenReceipt: true, receiverName: "John Smith", expected: "IN_REPAIR" },
  …
  { serial: `${PREFIX}12`, make: "Dell", model: "5540", deviceName: "Node twelve", uic: "W1AAAA", category: "Laptop", lastAuditedAt: JAN, onOpenReceipt: true, receiverName: "Doe, Marcus", expected: "DEPLOYED" },
```

Then append two seeds whose custody has ENDED. Both use `uic: "W3CCCC"` so the existing `uic filter` count is untouched, and names containing no "delta" so the existing `search term` count is untouched. Neither is `DEPLOYED`: the readiness EXISTS requires an open receipt with the row unreturned, which is exactly what these lack.

```ts
  { serial: `${PREFIX}15`, make: "Getac", model: "B360", deviceName: "Node fifteen", uic: "W3CCCC", category: null, lastAuditedAt: null, onOpenReceipt: true, receiptClosed: true, receiverName: "Ellen Doe", expected: "UNTRIAGED" },
  { serial: `${PREFIX}16`, make: "Getac", model: "S410", deviceName: "Node sixteen", uic: "W3CCCC", category: null, lastAuditedAt: null, onOpenReceipt: true, receiptReturned: true, receiverName: "Frank Doe", expected: "UNTRIAGED" },
```

Update the seeding loop's receipt block (lines 126-139) to honour the three new fields:

```ts
    if (s.onOpenReceipt) {
      await prisma.transfer.create({
        data: {
          receiptNumber: `${PREFIX}R${i}`, itemSummary: "x",
          senderName: "s", receiverName: s.receiverName ?? "r", receiverSignature: "",
          status: s.receiptClosed ? "CLOSED" : "OPEN",
          closedAt: s.receiptClosed ? JUN : null,
          lines: {
            create: [{
              lineNo: 1, make: s.make, model: s.model, qtyAuth: 1, qtyIssued: 1,
              items: {
                create: [{
                  itemId: item.id,
                  serialNumber: s.serial,
                  returnedAt: s.receiptReturned ? JUN : null,
                }],
              },
            }],
          },
        },
      });
    }
```

Add two filter cases to `FILTERS` (after the `search + uic` entry at line 79):

```ts
  // Recipient search. "doe" reaches ONLY through the receipt: no seeded serial,
  // make, model or device name contains it. Two of the four "Doe" receipts are
  // live custody (03 "Jane Doe", 12 "Doe, Marcus"); 15 is closed and 16 is
  // returned, so both are excluded — asserted directly below as well, since a
  // parity test alone would pass if BOTH paths were equally wrong.
  { name: "recipient surname", opts: { search: "doe" }, size: 2 },
  // Surname-first. Tokens are AND'd, so this still finds "Jane Doe" (03) and
  // still excludes "Doe, Marcus" (12), who is not a Jane.
  { name: "recipient reversed name", opts: { search: "doe jane" }, size: 1 },
```

- [ ] **Step 8: Fix the paging assertion the two new seeds break**

`SEEDS.length` is now 16, but the test `"pages a readiness sort without dropping or duplicating a row"` (line ~205) walks only **3** pages of 5 and asserts it saw every row — so it now fails on 15 ≠ 16. Widen the loop rather than shrinking the seed set:

```ts
    // Pages deliberately overshoot the seed count: the point is that the id
    // tie-break makes every row appear exactly once, not that the table divides
    // evenly. Bump this whenever SEEDS grows.
    for (let page = 1; page <= 4; page++) {
```

- [ ] **Step 9: Add real-row exclusion assertions**

Still in `items.readiness-sort.parity.test.ts`, append a new `describe` block at the end of the file. Parity proves the two paths agree; this proves what they agree *on*.

```ts
describe("recipient search", () => {
  const serialsOf = async (opts: Parameters<typeof listItems>[0]) =>
    (await listItems({ pageSize: 100, ...opts })).items.map((it) => it.serialNumber);

  it("finds items by surname, first name, and the full name in either order", async () => {
    // 03 is issued to "Jane Doe" on an open receipt.
    for (const q of ["doe", "jane", "jane doe", "doe jane"]) {
      expect(await serialsOf({ search: q, sort: "serialNumber", dir: "asc" })).toContain(
        `${PREFIX}03`,
      );
    }
  });

  it("requires every token, so a wrong surname does not match on the first name alone", async () => {
    expect(await serialsOf({ search: "jane smith", sort: "serialNumber", dir: "asc" })).toEqual([]);
  });

  it("excludes a closed receipt and a returned row — custody has ended", async () => {
    const hits = await serialsOf({ search: "doe", sort: "serialNumber", dir: "asc" });
    expect(hits).not.toContain(`${PREFIX}15`); // receipt CLOSED
    expect(hits).not.toContain(`${PREFIX}16`); // row returned
    expect(hits.sort()).toEqual([`${PREFIX}03`, `${PREFIX}12`]);
  });

  it("excludes the same rows on the raw path (a readiness sort)", async () => {
    // The other filter implementation, reached by sorting on a derived key.
    const hits = await serialsOf({ search: "doe", sort: "readiness", dir: "asc" });
    expect(hits.sort()).toEqual([`${PREFIX}03`, `${PREFIX}12`]);
  });

  it("leaves device-column search untokenized", async () => {
    // "Delta Systems X1" exists; "delta x1" must NOT match it, because only the
    // recipient branch splits a query into tokens.
    expect(await serialsOf({ search: "delta x1", sort: "serialNumber", dir: "asc" })).toEqual([]);
  });
});
```

- [ ] **Step 10: Run the parity suite and watch it pass**

```
npx vitest run src/modules/items/items.readiness-sort.parity.test.ts
```

Expected: PASS. If the two new `FILTERS` cases fail on a size mismatch, the filter is wrong on the path that reported the wrong count — do not "fix" it by editing `size`.

Run it **alone**: a concurrent suite in another shell truncates the same test DB.

- [ ] **Step 11: Update CLAUDE.md**

In the **Data Fetching & N+1 Prevention** section, in the bullet describing the `/items` two-path filter (the one containing "The two paths each implement the `?q=` / `?uic=` filter, and two filter implementations drift"), append:

```
The `?q=` filter also spans a RELATION: it matches the recipient named on the item's current hand receipt (open, unreturned — the same custody rule `READINESS_CASE` uses for `DEPLOYED`, deliberately not `getHoldingTransfer`'s stricter latest-receipt rule, so search agrees with the Readiness badge beside it). On the Prisma side that is a nested `some`; on the raw side an `EXISTS` (`recipientMatchSql`). The recipient branch — and ONLY that branch — splits the query into whitespace tokens and ANDs them, so "doe jane" finds "Jane Doe"; both paths tokenize through `recipientTokens` in the leaf module `recipient-search.ts`, because two tokenizers would drift exactly like two filters.
```

- [ ] **Step 12: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.search.test.ts src/modules/items/items.readiness-sort.parity.test.ts CLAUDE.md
git commit -m "feat(items): match the open-receipt recipient in item search"
```

---

### Task 3: Trigram index on `Transfer.receiverName`

The match is `ILIKE '%tok%'` — a leading wildcard no B-tree can serve. Same shape and reasoning as `Item_serialNumber_trgm_idx`.

**Files:**
- Modify: `prisma/schema.prisma` (the `Transfer` model's index block, :281-295)
- Create: `prisma/migrations/<timestamp>_transfer_receiver_name_trgm/migration.sql`

**Interfaces:**
- Consumes: the query from Task 2 (this only makes it fast).
- Produces: an index named `Transfer_receiverName_trgm_idx`. No code depends on the name.

- [ ] **Step 1: Add the index to the schema**

In `prisma/schema.prisma`, inside `model Transfer`, directly after the existing `receiptNumber` trigram index (line 295), add:

```prisma
  // Trigram GIN for the recipient-name branch of item search (recipientMatchSql
  // in items.service.ts / the Prisma `some` twin), `ILIKE '%token%'`. Needs
  // pg_trgm. Note receiverName is a plain String, NOT citext — so unlike
  // Item.serialNumber it needs no `::text` cast to reach this index. That cast
  // exists there only because citext's own ILIKE operator cannot use a text
  // trigram index; do not copy it here.
  @@index([receiverName(ops: raw("gin_trgm_ops"))], type: Gin, map: "Transfer_receiverName_trgm_idx")
```

- [ ] **Step 2: Generate the migration**

`prisma migrate dev` cannot run in this shell (it prompts). Diff the live schema against the datamodel instead:

```
npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script
```

Expected output — exactly one statement, nothing else:

```sql
CREATE INDEX "Transfer_receiverName_trgm_idx" ON "Transfer" USING GIN ("receiverName" gin_trgm_ops);
```

If anything else appears, the local DB has drifted from `main`; stop and reconcile before continuing rather than folding unrelated DDL into this migration.

- [ ] **Step 3: Save it as a migration**

Create `prisma/migrations/20260730120000_transfer_receiver_name_trgm/migration.sql` containing that single statement. Use a timestamp later than the newest existing migration directory.

- [ ] **Step 4: Apply it and verify the index exists**

```
npx prisma migrate deploy
npx prisma generate
```

Then confirm against the dev database:

```
npx prisma db execute --stdin
```
with input:
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'Transfer' AND indexname = 'Transfer_receiverName_trgm_idx';
```

Expected: the index is listed. (`pg_trgm` is already installed — `Item_serialNumber_trgm_idx` depends on it.)

- [ ] **Step 5: Re-run the integration suite against the migrated DB**

```
npx vitest run src/modules/items/items.readiness-sort.parity.test.ts
```

Expected: PASS — same results, now index-backed. `migrateTestDb()` applies the new migration to the test DB automatically.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "perf(items): index Transfer.receiverName for recipient search"
```

> **Deploy note for whoever merges:** this migration must be applied to Supabase **before** the merge deploys. A bare `next build` never runs `migrate deploy`. The prod `DIRECT_URL` pulls empty, so hand-apply the DDL plus a `_prisma_migrations` row via the Supabase MCP in one transaction, with the CRLF sha256 checksum of the migration file.

---

### Task 4: `holdersForItems` — one query for the page's holders

**Files:**
- Create: `src/modules/transfers/holders.query.ts`
- Test: `src/modules/transfers/holders.query.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `holdersForItems(ids: string[]): Promise<Map<string, string>>` — keyed by item id, value is `Transfer.receiverName`. An item with no live custody is **absent** from the map. Task 5 calls this from `/items/page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/transfers/holders.query.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { holdersForItems } from "./holders.query";

const PREFIX = "HOLDERQ-";
const JAN = new Date("2026-01-01T00:00:00Z");
const JUN = new Date("2026-06-01T00:00:00Z");

const ids: Record<string, string> = {};

/** Seed one item plus, optionally, one receipt holding it. */
async function seed(
  key: string,
  adminId: string,
  receipt?: { receiverName: string; closed?: boolean; returned?: boolean; createdAt?: Date },
) {
  const item = await prisma.item.create({
    data: {
      make: "Dell", model: "5540", serialNumber: `${PREFIX}${key}`, createdById: adminId,
    },
  });
  ids[key] = item.id;
  if (receipt) {
    await prisma.transfer.create({
      data: {
        receiptNumber: `${PREFIX}R-${key}-${receipt.receiverName}`,
        itemSummary: "x", senderName: "s", receiverName: receipt.receiverName,
        receiverSignature: "",
        status: receipt.closed ? "CLOSED" : "OPEN",
        closedAt: receipt.closed ? JUN : null,
        createdAt: receipt.createdAt ?? JAN,
        lines: {
          create: [{
            lineNo: 1, make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1,
            items: {
              create: [{
                itemId: item.id,
                serialNumber: `${PREFIX}${key}`,
                returnedAt: receipt.returned ? JUN : null,
              }],
            },
          }],
        },
      },
    });
  }
  return item.id;
}

beforeAll(async () => {
  migrateTestDb();
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Holders", email: "holders@x.co", passwordHash: "x", role: "ADMIN" },
  });
  await seed("OPEN", admin.id, { receiverName: "Jane Doe" });
  await seed("CLOSED", admin.id, { receiverName: "Ellen Doe", closed: true });
  await seed("RETURNED", admin.id, { receiverName: "Frank Doe", returned: true });
  await seed("NONE", admin.id);
  // Two live receipts for one device: the map holds ONE name, the newer.
  await seed("TWO", admin.id, { receiverName: "Older Holder", createdAt: JAN });
  await prisma.transfer.create({
    data: {
      receiptNumber: `${PREFIX}R-TWO-NEWER`, itemSummary: "x", senderName: "s",
      receiverName: "Newer Holder", receiverSignature: "", status: "OPEN", createdAt: JUN,
      lines: {
        create: [{
          lineNo: 1, make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1,
          items: { create: [{ itemId: ids.TWO, serialNumber: `${PREFIX}TWO` }] },
        }],
      },
    },
  });
});

afterAll(async () => {
  await resetDb();
});

describe("holdersForItems", () => {
  it("returns the recipient of an open, unreturned receipt", async () => {
    expect((await holdersForItems([ids.OPEN])).get(ids.OPEN)).toBe("Jane Doe");
  });

  it("omits an item whose receipt is closed — custody has ended", async () => {
    expect((await holdersForItems([ids.CLOSED])).has(ids.CLOSED)).toBe(false);
  });

  it("omits an item whose row was returned, even on an open receipt", async () => {
    expect((await holdersForItems([ids.RETURNED])).has(ids.RETURNED)).toBe(false);
  });

  it("omits an item that was never hand-receipted", async () => {
    expect((await holdersForItems([ids.NONE])).has(ids.NONE)).toBe(false);
  });

  it("returns ONE name for an item on two open receipts — the newer", async () => {
    // DISTINCT ON is what stops a second receipt duplicating a table row.
    const map = await holdersForItems([ids.TWO]);
    expect(map.get(ids.TWO)).toBe("Newer Holder");
  });

  it("answers for a whole page in one query, and returns an empty map for no ids", async () => {
    const map = await holdersForItems(Object.values(ids));
    expect(map.get(ids.OPEN)).toBe("Jane Doe");
    expect(map.size).toBe(2); // OPEN and TWO; the other three have no live custody
    expect((await holdersForItems([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
npx vitest run src/modules/transfers/holders.query.test.ts
```

Expected: FAIL — `Failed to resolve import "./holders.query"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/transfers/holders.query.ts`:

```ts
import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

/**
 * Who currently holds each of these items, in ONE query.
 *
 * WHY SQL AND NOT A PRISMA INCLUDE PER ROW: custody lives two joins away
 * (Item -> TransferItem -> TransferLine -> Transfer), so resolving it per row is
 * the N+1 CLAUDE.md forbids. Shaped exactly like readinessForItems: bounded by
 * the caller to a page of ids, returns a Map so the caller renders in its own
 * order, and an id with no live custody is simply ABSENT rather than null.
 *
 * THE CUSTODY RULE IS THE READINESS ONE — an open receipt with this row
 * unreturned, matching READINESS_CASE's DEPLOYED branch — NOT
 * getHoldingTransfer's stricter "latest receipt only, fail closed". The two can
 * differ when an item sits on an older open receipt and a newer closed one.
 * This is the rule the /items search filters by and the Readiness badge shows,
 * so the Holder column must use it or the same row would contradict itself.
 * getHoldingTransfer keeps its stricter rule because it prefills a signed
 * DA 2062, where naming the wrong holder is worse than naming none.
 *
 * DISTINCT ON picks the most recent open receipt if an item somehow sits on
 * two, so the column shows one name instead of fanning the row out.
 *
 * Ids are BOUND via Prisma.join, never spliced (CLAUDE.md §2).
 */
export async function holdersForItems(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => id !== ""))];
  if (wanted.length === 0) return new Map();

  const rows = await prisma.$queryRaw<{ itemId: string; receiverName: string }[]>(Prisma.sql`
    SELECT DISTINCT ON (ti."itemId") ti."itemId" AS "itemId", t."receiverName" AS "receiverName"
    FROM "TransferItem" ti
    JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
    JOIN "Transfer" t ON t."id" = tl."transferId"
    WHERE ti."itemId" IN (${Prisma.join(wanted)})
      AND ti."returnedAt" IS NULL
      AND t."status" = 'OPEN'
    ORDER BY ti."itemId", t."createdAt" DESC
  `);
  return new Map(rows.map((r) => [r.itemId, r.receiverName]));
}
```

- [ ] **Step 4: Run it and watch it pass**

```
npx vitest run src/modules/transfers/holders.query.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/holders.query.ts src/modules/transfers/holders.query.test.ts
git commit -m "feat(items): derive the current holder for a page of items in one query"
```

---

### Task 5: The Holder column and the placeholder

`holder` is the first column the table displays but cannot sort by, so `SORTABLE_COLUMNS` stops being an alias of `ITEM_COLUMNS` and `ColumnKey` stops being identical to `SortField`. Both files document the old invariant; both comments must change with the code.

**Files:**
- Modify: `src/components/items-view.ts` (:19-23, :32-45, :49-64)
- Modify: `src/components/ItemSelectTable.tsx` (`renderRow`, :130-161)
- Modify: `src/app/items/page.tsx` (:50-54, :85-99)
- Modify: `src/app/items/ItemsSearchInput.tsx` (:78)

**Interfaces:**
- Consumes: `holdersForItems` from Task 4.
- Produces: `ItemRow.holderName: string | null`; `ColumnKey = SortField | "holder"`.

- [ ] **Step 1: Widen `ColumnKey` and add `holderName` to `ItemRow`**

In `src/components/items-view.ts`, replace the `ColumnKey` declaration and its comment (lines 19-23):

```ts
/** Every column the table can render.
 *
 *  NO LONGER identical to SortField. `holder` is displayed but not
 *  server-sortable: the current holder comes from a two-join custody lookup
 *  (modules/transfers/holders.query.ts) with no column for Prisma to name, and
 *  it is deliberately NOT a third derived sort key — that would mean a scalar
 *  subquery in the raw ORDER BY, its own parity coverage and a nulls decision.
 *  Sortability is the SORTABLE_COLUMNS list below; visibility is this one. */
export type ColumnKey = SortField | "holder";
```

Add to `ItemRow` (after `readiness` at line 44):

```ts
  /** The recipient named on this item's current hand receipt — open, with this
   *  row unreturned. Null when nothing holds it. Derived server-side for the
   *  whole page in one query — never per row. See
   *  modules/transfers/holders.query.ts. */
  holderName: string | null;
```

- [ ] **Step 2: Add the column and split `SORTABLE_COLUMNS`**

In `ITEM_COLUMNS` (line 49-59), insert after the `serialNumber` entry:

```ts
  { key: "holder", label: "Holder" },
```

Replace `SORTABLE_COLUMNS` and its comment (lines 61-64):

```ts
/** The Sort control's options — every column EXCEPT `holder`.
 *
 *  This used to be `ITEM_COLUMNS` itself, on the invariant that the table shows
 *  nothing it cannot also sort. `holder` breaks that invariant deliberately (see
 *  ColumnKey), so the two lists diverge here rather than offering a sort the
 *  server would silently drop: parseSortKeys does not accept `holder`, so a
 *  `?sort=holder` URL falls back to the default order with no error. */
export const SORTABLE_COLUMNS: { key: SortField; label: string }[] = ITEM_COLUMNS.filter(
  (c): c is { key: SortField; label: string } => c.key !== "holder",
);
```

`SORT_FIELDS` (built from `SORTABLE_COLUMNS`) and `COLUMN_KEYS` (built from `ITEM_COLUMNS`) now legitimately differ — the comment at lines 67-68 already explains that they are separate sets, so leave it.

- [ ] **Step 3: Render the cell**

In `src/components/ItemSelectTable.tsx`, in `renderRow`, add after the `serialNumber` cell (line 136):

```tsx
      {!isHidden("holder") && <td data-label="Holder">{it.holderName ?? <span className="subtle">—</span>}</td>}
```

- [ ] **Step 4: Fetch and pass the holders**

In `src/app/items/page.tsx`, replace the `readinessForItems` call (lines 50-54) with:

```ts
  // Neither readiness nor the current holder can ride along on the item row —
  // both are derived from other tables. TWO extra queries derive them for the
  // whole page at once, never one per row, and both must follow listItems
  // because they need the page's ids. Bounded by ITEMS_PAGE_SIZE.
  const ids = result.items.map((it) => it.id);
  const [readiness, holders] = await Promise.all([
    readinessForItems(ids),
    holdersForItems(ids),
  ]);
```

Add the import beside the readiness one (after line 5):

```ts
import { holdersForItems } from "@/modules/transfers/holders.query";
```

And in the `items.map(...)` passed to `ItemSelectTable`, after `serialNumber` (line 91):

```ts
              // Absent from the map = nothing currently holds it.
              holderName: holders.get(it.id) ?? null,
```

- [ ] **Step 5: Update the placeholder**

In `src/app/items/ItemsSearchInput.tsx` line 78:

```tsx
        placeholder="Search device name, make, model, serial number, or recipient"
```

- [ ] **Step 6: Typecheck, lint and build**

```
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all clean. `tsc` is the real gate here — every construction site of `ItemRow` must now supply `holderName`, and any that does not is a compile error. If one turns up outside `/items/page.tsx`, give it `holderName: null` unless it can cheaply supply a real value.

- [ ] **Step 7: Verify in a real browser**

`npm run build` and jsdom are **not** evidence for a UI change — neither has a layout engine.

```
npm run dev
```

Sign in, open `/items`, and confirm:
1. A **Holder** column sits between Serial and UIC; items with no open receipt show `—`.
2. The column toggle list offers **Holder**, and hiding it removes the cell.
3. The **Sort by** dropdown does **not** offer Holder.
4. Typing a recipient's surname filters the list to that person's items, and the Holder column shows why each row matched.
5. Typing the name surname-first (`doe jane`) returns the same row.
6. Searching a device name/serial still behaves as before.

- [ ] **Step 8: Commit**

```bash
git add src/components/items-view.ts src/components/ItemSelectTable.tsx src/app/items/page.tsx src/app/items/ItemsSearchInput.tsx
git commit -m "feat(items): show the current holder on the items list"
```

---

### Task 6: Changelog and full verification

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Add the changelog entry**

`CHANGELOG.md` already has a `## 2026-07-30` section. Add to its existing `### Added` list (describe the behavior change for a reader, not the diff):

```markdown
- **The items list can now be searched by who is holding the device.** Typing a recipient's name into the search box on the items list returns everything that person currently has signed out — matching on first name, last name, or both, in either order, so "doe jane" finds Jane Doe. Only live custody counts: an item comes back while it is out on an open hand receipt and stops matching once that receipt is closed or the item is returned. The list also gained a **Holder** column showing that name (blank for anything nobody has signed for), so it is visible why each row matched; it can be hidden from the column menu. Devices assigned only through the MDM import, with no hand receipt, are not matched by a name search.
```

Add to that section's existing `### Notes`:

```markdown
- A new migration adds a trigram index on the hand-receipt recipient name, which the name search needs to stay fast. It must be applied to the production database before this deploys.
```

- [ ] **Step 2: Run the whole suite**

Run these **alone** — no other agent or shell running tests against the same database.

```
npx vitest run
npx vitest run integration
```

Expected: PASS. If `readiness.parity.test.ts` fails, something in this work touched a readiness twin — it should not have.

- [ ] **Step 3: Lint and build**

```
npm run lint
npm run build
```

Expected: clean.

- [ ] **Step 4: Confirm the security-docs gate stays quiet**

```
npm run check:security-docs
```

Expected: PASS with no `docs/SECURITY.md` requirement — no watched file was touched. If it demands a SECURITY.md edit, a watched file changed unintentionally; find it rather than editing the doc to appease the check.

- [ ] **Step 5: Commit and open the PR**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for recipient-name item search"
git push -u origin feat/search-items-by-recipient
```

Then open a PR against `main` (required checks: `Semgrep SAST`, `Build (next build)`, `Security docs current`). **Apply the migration to Supabase before merging** — see the deploy note on Task 3.

---

## Self-Review

**Spec coverage.** §1 custody rule → Global Constraints + Tasks 2/4. §2 tokenization incl. the cap → Task 1, asserted in Tasks 2 and 5. §3.1 Prisma path → Task 2 Step 4. §3.2 raw path → Task 2 Step 5. §3.3 index + migration → Task 3. §3.4 security posture → Task 6 Step 4. §4.1 `holdersForItems` → Task 4. §4.2 rendering → Task 5 Steps 1-4. §4.3 sortability split → Task 5 Steps 1-2. §5 placeholder → Task 5 Step 5. §6 testing → Tasks 1, 2, 4 + Task 6 Step 2. §7 docs → Task 2 Step 10 (CLAUDE.md), Task 6 Step 1 (CHANGELOG), SECURITY.md correctly untouched.

**Placeholders.** None — every code step carries the literal code, and no step defers a decision.

**Type consistency.** `recipientTokens(search: string): string[]` is defined in Task 1 and called with that signature in Task 2 (both paths). `holdersForItems(ids: string[]): Promise<Map<string, string>>` is defined in Task 4 and consumed in Task 5 as `holders.get(id) ?? null`, matching `ItemRow.holderName: string | null`. `ColumnKey = SortField | "holder"` (Task 5 Step 1) is what lets `{ key: "holder" }` into `ITEM_COLUMNS` (Step 2) and `isHidden("holder")` compile (Step 3). The column key is `"holder"` and the label `"Holder"` at every site.
