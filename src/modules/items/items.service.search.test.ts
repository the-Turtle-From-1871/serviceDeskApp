import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { item: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) }, $queryRaw: vi.fn(async () => []) } }));
import prisma from "@/lib/prisma";
import { searchItemsBySerial, getItemWithCreator, listItems } from "./items.service";

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
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.orderBy).toEqual([{ make: "asc" }, { id: "asc" }]);
  });

  it("maps the derived auditState sort to lastAuditedAt, nulls last, in both directions", async () => {
    vi.mocked(prisma.item.count).mockResolvedValue(100);

    await listItems({ sort: "auditState", dir: "asc" });
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.orderBy).toEqual([
      { lastAuditedAt: { sort: "asc", nulls: "last" } },
      { id: "asc" },
    ]);

    vi.mocked(prisma.item.findMany).mockClear();
    await listItems({ sort: "auditState", dir: "desc" });
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.orderBy).toEqual([
      { lastAuditedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ]);
  });

  it("ignores an unknown sort key, falling back to the default order", async () => {
    vi.mocked(prisma.item.count).mockResolvedValueOnce(100);
    await listItems({ sort: "bogus", dir: "asc" });
    expect(vi.mocked(prisma.item.findMany).mock.calls[0][0]!.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
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
