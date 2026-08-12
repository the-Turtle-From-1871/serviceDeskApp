import { describe, it, expect, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { setItemsLoaner, commitImport } from "./items.service";
import { resetDb } from "../../../tests/helpers/db";

// Item.createdById is a required relation, so every row here needs an actor —
// same pattern as items.rename.test.ts / items.service.import.test.ts.
let admin: { id: string; name: string };

async function mkItem(serial: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: {
      make: "Dell",
      model: "5540",
      serialNumber: serial,
      deviceName: `dev-${serial}`,
      status,
      createdById: admin.id,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  admin = { id: a.id, name: a.name };
});

describe("setItemsLoaner", () => {
  it("marks a batch and clears it again", async () => {
    const items = await Promise.all([mkItem("LOAN1"), mkItem("LOAN2")]);
    const ids = items.map((i) => i.id);

    expect(await setItemsLoaner(ids, true)).toEqual({ updated: 2, skipped: 0 });
    let rows = await prisma.item.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.isLoaner)).toBe(true);

    expect(await setItemsLoaner(ids, false)).toEqual({ updated: 2, skipped: 0 });
    rows = await prisma.item.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => !r.isLoaner)).toBe(true);
  });

  // A device that has left the fleet cannot be pool stock, and one retired row
  // must not fail a batch of fifty.
  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("LOAN3");
    const retired = await mkItem("LOAN4", "RETIRED");

    expect(await setItemsLoaner([active.id, retired.id], true)).toEqual({ updated: 1, skipped: 1 });

    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: retired.id } });
    expect(fresh.isLoaner).toBe(false);
  });

  it("is idempotent", async () => {
    const item = await mkItem("LOAN5");
    await setItemsLoaner([item.id], true);
    expect(await setItemsLoaner([item.id], true)).toEqual({ updated: 1, skipped: 0 });
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.isLoaner).toBe(true);
  });

  it("is a no-op for an empty list", async () => {
    expect(await setItemsLoaner([], true)).toEqual({ updated: 0, skipped: 0 });
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(setItemsLoaner(ids, true)).rejects.toMatchObject({ code: "TOO_MANY" });
  });

  // THE property this column exists for. deviceCategory, homeUnit and
  // storageLocation are all importable, so a loaner mark stored in any of them
  // would be reverted by the nightly Drive import within a day. commitImport
  // writes a NAMED column set built from the CSV row, and isLoaner is not in it.
  // A future refactor that widened that set would break this silently.
  it("survives a CSV import that updates the same device", async () => {
    const item = await mkItem("LOAN6");
    await setItemsLoaner([item.id], true);

    const csv = ["serialNumber,deviceName", "LOAN6,renamed-by-import"].join("\n");
    await commitImport(csv, "items.csv", admin);

    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.deviceName).toBe("renamed-by-import");
    expect(fresh.isLoaner).toBe(true);
  });
});
