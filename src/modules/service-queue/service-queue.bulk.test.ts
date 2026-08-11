import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { upsertServiceRequests } from "./service-queue.service";

let adminId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

async function mkItem(serial: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: {
      make: "Dell",
      model: "5540",
      serialNumber: serial,
      deviceName: `dev-${serial}`,
      status,
      createdById: adminId,
    },
  });
}

describe("upsertServiceRequests", () => {
  it("creates a PENDING row for every item that had none", async () => {
    const items = await Promise.all([mkItem("BULKQ1"), mkItem("BULKQ2")]);
    const res = await upsertServiceRequests({
      itemIds: items.map((i) => i.id),
      serviceType: "REIMAGE",
    });
    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rows = await prisma.serviceQueueItem.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.dueAt === null)).toBe(true);
  });

  it("WIPES a COMPLETED row's stale deadline before reopening it — a new round resets", async () => {
    const item = await mkItem("BULKQ3");
    await prisma.serviceQueueItem.create({
      data: {
        itemId: item.id,
        serviceType: "REPAIR",
        status: "COMPLETED",
        dueAt: new Date("2026-01-01"),
        overdueAlertedAt: new Date("2026-01-02"),
      },
    });

    await upsertServiceRequests({ itemIds: [item.id], serviceType: "REIMAGE" });

    const row = await prisma.serviceQueueItem.findUniqueOrThrow({ where: { itemId: item.id } });
    expect(row.status).toBe("PENDING");
    expect(row.dueAt).toBeNull();
    expect(row.overdueAlertedAt).toBeNull();
  });

  it("leaves a live PENDING row's deadline untouched when no days are given", async () => {
    const item = await mkItem("BULKQ4");
    const due = new Date("2026-12-01T00:00:00.000Z");
    await prisma.serviceQueueItem.create({
      data: { itemId: item.id, serviceType: "REPAIR", status: "PENDING", dueAt: due },
    });

    await upsertServiceRequests({ itemIds: [item.id], serviceType: "REIMAGE" });

    const row = await prisma.serviceQueueItem.findUniqueOrThrow({ where: { itemId: item.id } });
    expect(row.serviceType).toBe("REIMAGE");
    expect(row.dueAt?.getTime()).toBe(due.getTime());
  });

  it("sets a fresh deadline on every row when days are given", async () => {
    const items = await Promise.all([mkItem("BULKQ5"), mkItem("BULKQ6")]);
    await upsertServiceRequests({
      itemIds: items.map((i) => i.id),
      serviceType: "REPAIR",
      overrideDays: 7,
    });
    const rows = await prisma.serviceQueueItem.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(rows.every((r) => r.dueAt !== null)).toBe(true);
  });

  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("BULKQ7");
    const retired = await mkItem("BULKQ8", "RETIRED");
    const res = await upsertServiceRequests({
      itemIds: [active.id, retired.id],
      serviceType: "REPAIR",
    });
    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(await prisma.serviceQueueItem.count({ where: { itemId: retired.id } })).toBe(0);
  });

  it("requires a note for OTHER", async () => {
    const item = await mkItem("BULKQ9");
    await expect(
      upsertServiceRequests({ itemIds: [item.id], serviceType: "OTHER", note: "  " }),
    ).rejects.toMatchObject({ code: "NOTE_REQUIRED" });
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      upsertServiceRequests({ itemIds: ids, serviceType: "REPAIR" }),
    ).rejects.toMatchObject({ code: "TOO_MANY" });
  });
});
