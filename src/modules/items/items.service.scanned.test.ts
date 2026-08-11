import { describe, it, expect, vi, beforeEach } from "vitest";

const createMany = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { item: { createMany: (a: unknown) => createMany(a), findMany: (a: unknown) => findMany(a) } } }));

import { createScannedItems } from "./items.service";

beforeEach(() => {
  vi.clearAllMocks();
  createMany.mockResolvedValue({ count: 2 });
  findMany.mockResolvedValue([
    { id: "i1", make: "HP", model: "G5", serialNumber: "AAA1", status: "ACTIVE" },
    { id: "i2", make: "HP", model: "G5", serialNumber: "BBB2", status: "ACTIVE" },
  ]);
});

const rows = [
  { make: "HP", model: "G5", serialNumber: "AAA1" },
  { make: "HP", model: "G5", serialNumber: "BBB2" },
];

describe("createScannedItems", () => {
  // The non-negotiable property: never one create per row.
  it("writes with TWO queries regardless of row count", async () => {
    await createScannedItems(rows, "admin1");
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("leans on the unique constraint rather than pre-checking", async () => {
    await createScannedItems(rows, "admin1");
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
  });

  it("reports what was created versus what already existed", async () => {
    createMany.mockResolvedValue({ count: 1 });
    const res = await createScannedItems(rows, "admin1");
    expect(res).toMatchObject({ created: 1, existed: 1 });
    expect(res.items).toHaveLength(2);
  });

  it("is a no-op for an empty batch", async () => {
    const res = await createScannedItems([], "admin1");
    expect(res).toEqual({ items: [], created: 0, existed: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});
