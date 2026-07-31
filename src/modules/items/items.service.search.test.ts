import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { item: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) }, $queryRaw: vi.fn(async () => []) } }));
import prisma from "@/lib/prisma";
import {
  searchItemsBySerial,
  getItemWithCreator,
  listItems,
  ITEM_SORT_COLUMNS,
  SORT_COLUMN,
} from "./items.service";
import { DERIVED_SORT_KEYS } from "./sort-keys";

beforeEach(() => vi.clearAllMocks());

describe("listItems", () => {
  const whereOf = () => vi.mocked(prisma.item.findMany).mock.calls[0][0]?.where as
    | { OR: Record<string, { contains: string; mode: string }>[] }
    | undefined;

  it("searches device name alongside make, model and serial", async () => {
    await listItems({ search: "router" });
    const fields = whereOf()!.OR.map((c) => Object.keys(c)[0]);
    expect(fields).toEqual(["deviceName", "make", "model", "serialNumber"]);
  });

  it("matches device name case-insensitively on a partial value", async () => {
    await listItems({ search: "Edge Rou" });
    const deviceName = whereOf()!.OR.find((c) => "deviceName" in c)!.deviceName;
    expect(deviceName).toEqual({ contains: "Edge Rou", mode: "insensitive" });
  });

  it("trims the query before searching", async () => {
    await listItems({ search: "  router  " });
    expect(whereOf()!.OR[0].deviceName.contains).toBe("router");
  });

  it("applies no filter for a blank or missing query", async () => {
    await listItems({ search: "   " });
    expect(whereOf()).toBeUndefined();
    vi.clearAllMocks();
    await listItems();
    expect(whereOf()).toBeUndefined();
  });

  const orderOf = () => vi.mocked(prisma.item.findMany).mock.calls[0][0]!.orderBy;

  it("paginates with skip/take and a stable default order (createdAt desc, id asc)", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ page: 3, pageSize: 10 });
    const arg = vi.mocked(prisma.item.findMany).mock.calls[0][0]!;
    expect(arg.take).toBe(10);
    expect(arg.skip).toBe(20); // (page 3 - 1) * 10
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("sorts by a server-sortable column, mapping straight to the like-named column", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "make", dir: "asc" });
    expect(orderOf()).toEqual([{ make: "asc" }, { id: "asc" }]);
  });

  /** The expected physical column per sort key, written out INDEPENDENTLY.
   *
   *  Deliberately not `SORT_COLUMN[key]`. Deriving the expectation from the map
   *  under test makes a wrong entry unfalsifiable: the implementation and the
   *  assertion both read the same value, so `make: "model"` would satisfy both
   *  and /items would silently order by the wrong column. A test needs an
   *  oracle the implementation cannot supply. The exhaustiveness check below
   *  keeps this table from falling behind the allowlist. */
  const EXPECTED_COLUMN: Record<string, string> = {
    deviceName: "deviceName",
    make: "make",
    model: "model",
    serialNumber: "serialNumber",
    status: "status",
    deviceUIC: "deviceUIC",
    deviceCategory: "deviceCategory",
  };
  // Derived keys have NO column — they are ranked CASEs on the raw path — so
  // they are excluded here and covered by their own assertions below.
  const PRISMA_PATH_KEYS = [...ITEM_SORT_COLUMNS].filter((k) => !DERIVED_SORT_KEYS.has(k));

  it("pins an expected column for every key the server accepts", () => {
    expect(Object.keys(EXPECTED_COLUMN).sort()).toEqual([...PRISMA_PATH_KEYS].sort());
    // And the map under test agrees with the independent table.
    for (const key of PRISMA_PATH_KEYS) expect(SORT_COLUMN[key]).toBe(EXPECTED_COLUMN[key]);
  });

  // Every clause is a bare `{ column: dir }` and never `{ sort, nulls }`, so a
  // nullable column's blanks sort as a VALUE: they swap ends with the direction
  // and reversing a sort reverses the WHOLE list. Asserted for every key, not
  // just the nullable ones — the rule is that NO key pins, and a pin added to a
  // non-null column today is a pin waiting for that column to become nullable.
  it.each(PRISMA_PATH_KEYS)("maps %s to a bare { column: dir }, no nulls override", async (sortKey) => {
    for (const dir of ["asc", "desc"] as const) {
      vi.mocked(prisma.item.findMany).mockClear();
      vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
      await listItems({ sort: sortKey, dir });
      expect(orderOf()).toEqual([{ [EXPECTED_COLUMN[sortKey]]: dir }, { id: "asc" }]);
    }
  });

  // Asserted against the ORDER BY ALONE, and with the direction attached.
  // Matching the whole statement was vacuous: itemFilterSql names deviceName,
  // make, model, serialNumber and deviceUIC in its WHERE, and READINESS_CASE
  // names status — so six of these eight keys "passed" even with the entire
  // non-readiness ORDER BY branch deleted. `i."col" ASC` appears only where the
  // sort term is actually emitted.
  it.each(PRISMA_PATH_KEYS)("orders by the mapped column on the raw readiness path (%s)", async (sortKey) => {
    // BOTH directions. Asserting only ASC left the direction unchecked on this
    // path: hard-coding `Prisma.raw("ASC")` in readinessOrderedItemIds passed
    // every case, while the release notes claim the two paths behave alike
    // whichever keys you sort by.
    for (const [dir, sql] of [
      ["asc", "ASC"],
      ["desc", "DESC"],
    ] as const) {
      vi.mocked(prisma.$queryRaw).mockClear();
      vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
      await listItems({ sort: `readiness,${sortKey}`, dir });

      const [emitted] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
        { strings: string[] },
      ];
      const text = emitted.strings.join("");
      const orderBy = text.slice(text.lastIndexOf("ORDER BY"));
      expect(orderBy).toContain(`i."${EXPECTED_COLUMN[sortKey]}" ${sql}`);
    }
  });

  it("sends an auditState sort down the raw path, ranked by badge not by timestamp", async () => {
    // ...Once, not a persistent implementation: `clearAllMocks` wipes call
    // records but NOT implementations, so a sticky mockResolvedValue here would
    // silently set count=100 for every test declared after this one and make
    // declaration order load-bearing for anything that reads totalPages.
    for (const [dir, sql] of [
      ["asc", "ASC"],
      ["desc", "DESC"],
    ] as const) {
      vi.mocked(prisma.$queryRaw).mockClear();
      vi.mocked(prisma.item.findMany).mockClear();
      vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
      await listItems({ sort: "auditState", dir });

      // The Prisma path must not run at all — auditState has no column.
      expect(vi.mocked(prisma.item.findMany)).not.toHaveBeenCalled();

      const [emitted] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
        { strings: string[] },
      ];
      const text = emitted.strings.join("");
      const orderBy = text.slice(text.lastIndexOf("ORDER BY"));
      // Ranked CASE over lastAuditedAt, NOT a bare `i."lastAuditedAt"` term.
      // That bare term is the regression: stamps are near-unique, so a
      // secondary key had no ties to break and silently did nothing.
      expect(orderBy).not.toContain(`i."lastAuditedAt" ${sql}`);
      expect(orderBy).toContain("CASE");
      expect(orderBy).toContain(`END) ${sql}`);
      expect(orderBy).toContain(`i."id" ASC`);
    }
  });

  it("keeps a secondary key after the audit rank, so it can order within a badge", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "auditState,deviceName", dir: "desc,asc" });

    const [emitted] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      { strings: string[] },
    ];
    const text = emitted.strings.join("");
    const orderBy = text.slice(text.lastIndexOf("ORDER BY"));
    // Each key carries its OWN direction — `dir` is a parallel list, not one
    // flag for the whole ORDER BY — and the secondary follows the rank.
    expect(orderBy).toContain(`END) DESC`);
    expect(orderBy).toContain(`i."deviceName" ASC`);
    expect(orderBy.indexOf("END) DESC")).toBeLessThan(orderBy.indexOf(`i."deviceName"`));
  });

  // The raw path is the OTHER half of the no-pinning rule, and the parity test
  // cannot see it: that test compares the two paths against each other, so
  // reinstating NULLS LAST on BOTH would keep it green while reverting the fix.
  // This asserts the emitted SQL directly.
  it.each(["asc", "desc"] as const)(
    "emits no NULLS override on the raw readiness path (%s)",
    async (dir) => {
      vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
      await listItems({ sort: "readiness,deviceUIC", dir });

      const [sql] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
        { strings: string[] },
      ];
      const text = sql.strings.join(" ");
      expect(text).toMatch(/ORDER BY/i);
      expect(text).not.toMatch(/NULLS/i);
      // The readiness key must not have quietly fallen back to the Prisma path.
      expect(prisma.item.findMany).not.toHaveBeenCalled();
    },
  );

  it("ignores an unknown sort key, falling back to the default order", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "bogus", dir: "asc" });
    expect(orderOf()).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("orders by the chosen sort alone — no readiness clause is prepended", async () => {
    // The list used to group by readiness ahead of the user's sort. It no
    // longer does: readiness composition is the analytics dashboard's job, and
    // the group clause silently demoted the chosen sort to a within-group one.
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "make", dir: "asc" });
    expect(orderOf()).toEqual([{ make: "asc" }, { id: "asc" }]);
  });

  it("sends a readiness sort down the raw path instead of Prisma's orderBy", async () => {
    // Readiness comes from four signals across three tables (readiness.ts), so
    // there is no column for a Prisma orderBy to name — it is ordered in SQL
    // and the page is hydrated by id. Prisma must therefore never be handed a
    // `readiness` orderBy: this asserts the ordering query is the raw one.
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "readiness", dir: "desc" });
    const arg = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as { sql: string; values: unknown[] };
    expect(arg.sql).toMatch(/ORDER BY[\s\S]*DESC/i);

    // The rank's comparisons are BOUND, not spliced: every WHEN compares
    // against a placeholder.
    //
    // Note the statement DOES contain the state names as literals — they are
    // the THEN outputs of READINESS_CASE, hardcoded in our own source. That is
    // not the risk; the risk would be a value flowing from the querystring into
    // the text, so this asserts the comparison side specifically.
    expect(arg.sql).not.toMatch(/WHEN\s+'(DEPLOYED|READY_TO_DEPLOY|IN_REPAIR|RETIRED|UNTRIAGED)'/);
    expect(arg.values).toContain("READY_TO_DEPLOY");
    // The mock returns no ids, so no page is hydrated — Prisma is never handed
    // an orderBy for this sort at all.
    expect(vi.mocked(prisma.item.findMany)).not.toHaveBeenCalled();
  });

  it("orders a compound sort in the order the keys were given", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "make,serialNumber", dir: "asc,desc" });
    expect(orderOf()).toEqual([{ make: "asc" }, { serialNumber: "desc" }, { id: "asc" }]);
  });

  it("filters by UIC without disturbing the search filter", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ search: "router", uic: "W6BTAA" });
    const where = vi.mocked(prisma.item.findMany).mock.calls[0][0]!.where as { AND: unknown[] };
    expect(where.AND).toHaveLength(2);
    expect(where.AND[1]).toEqual({ deviceUIC: "W6BTAA" });
  });

  it("applies a UIC filter on its own without wrapping it in AND", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ uic: "W6BTAA" });
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.where).toEqual({ deviceUIC: "W6BTAA" });
  });

  it("treats a blank UIC as no filter", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ uic: "   " });
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.where).toBeUndefined();
  });
});

describe("searchItemsBySerial", () => {
  it("returns [] for a blank query without hitting the DB", async () => {
    expect(await searchItemsBySerial("  ")).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it("uses a ::text ILIKE raw query (trigram-index-friendly) with a bound pattern param", async () => {
    await searchItemsBySerial("sn12");
    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    const sql = (call[0] as unknown as string[]).join("?");
    expect(sql).toMatch(/"serialNumber"::text ILIKE/i);
    expect(call[1]).toBe("%sn12%");
  });
});

describe("getItemWithCreator", () => {
  it("looks up by id and includes the creator's rank/name", async () => {
    await getItemWithCreator("itm1");
    const arg = vi.mocked(prisma.item.findUnique).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "itm1" });
    expect(arg.include).toEqual({ createdBy: { select: { rank: true, name: true } } });
  });
});
