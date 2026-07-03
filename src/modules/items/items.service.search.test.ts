import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { item: { findMany: vi.fn(async () => []) } } }));
import prisma from "@/lib/prisma";
import { searchItemsBySerial } from "./items.service";

beforeEach(() => vi.clearAllMocks());

describe("searchItemsBySerial", () => {
  it("returns [] for a blank query without hitting the DB", async () => {
    expect(await searchItemsBySerial("  ")).toEqual([]);
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });
  it("queries by serialNumber contains, case-insensitive", async () => {
    await searchItemsBySerial("sn12");
    const where = vi.mocked(prisma.item.findMany).mock.calls[0][0]?.where as { serialNumber: { contains: string; mode: string } };
    expect(where.serialNumber.contains).toBe("sn12");
    expect(where.serialNumber.mode).toBe("insensitive");
  });
});
