import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { renameItems, previewRename } from "./items.service";
import { resetDb } from "../../../tests/helpers/db";

let editorId: string;
const editor = () => ({ id: editorId, name: "Tech" });

async function mkItem(serial: string, deviceName: string | null, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName, status, createdById: editorId },
  });
}

beforeEach(async () => {
  await resetDb();
  editorId = (await prisma.user.create({
    data: { name: "Tech", email: `t${Date.now()}@unit.mil`, passwordHash: "x", role: "ADMIN" },
  })).id;
});

describe("renameItems", () => {
  it("writes a distinct consecutive name per item, in caller order", async () => {
    const a = await mkItem("R1", "old-a");
    const b = await mkItem("R2", "old-b");
    const c = await mkItem("R3", null);

    const res = await renameItems([c.id, a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 3, unchanged: 0, skipped: 0 });

    // Caller order decides the numbering, NOT insertion or serial order.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: c.id } })).deviceName).toBe("LAPTOP-001");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("LAPTOP-002");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: b.id } })).deviceName).toBe("LAPTOP-003");
  });

  it("refuses the WHOLE batch on a collision and writes nothing", async () => {
    const a = await mkItem("R4", "keep-me");
    const b = await mkItem("R5", "also-keep");
    await mkItem("R6", "LAPTOP-002"); // taken by a device outside the batch

    const res = await renameItems([a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toMatchObject({ ok: false });
    if (res.ok === false) {
      expect(res.collisions).toEqual([{ name: "LAPTOP-002", serialNumber: "R6" }]);
    }

    // Nothing partial landed.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("keep-me");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: b.id } })).deviceName).toBe("also-keep");
    expect(await prisma.itemEdit.count()).toBe(0);
  });

  it("matches collisions case-insensitively", async () => {
    const a = await mkItem("R7", "x");
    await mkItem("R8", "laptop-001");
    const res = await renameItems([a.id], "LAPTOP", "001", editor());
    expect(res).toMatchObject({ ok: false });
  });

  it("does NOT collide with a name held by an item inside the batch", async () => {
    // a already holds the name it is about to be given — that is a no-op, not a clash.
    const a = await mkItem("R9", "LAPTOP-001");
    const b = await mkItem("R10", "other");
    const res = await renameItems([a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 1, unchanged: 1, skipped: 0 });
  });

  it("excludes retired items and numbers the survivors CONSECUTIVELY", async () => {
    const a = await mkItem("R11", "a");
    const dead = await mkItem("R12", "b", "RETIRED");
    const c = await mkItem("R13", "c");

    const res = await renameItems([a.id, dead.id, c.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 2, unchanged: 0, skipped: 1 });

    // No hole at position 2 — the survivors get 001 and 002.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("LAPTOP-001");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: c.id } })).deviceName).toBe("LAPTOP-002");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: dead.id } })).deviceName).toBe("b");
  });

  it("writes one ItemEdit per CHANGED item, shaped like a hand edit", async () => {
    const a = await mkItem("R14", "was-a");
    await renameItems([a.id], "LAPTOP", "007", editor());

    const edits = await prisma.itemEdit.findMany({ where: { itemId: a.id } });
    expect(edits).toHaveLength(1);
    expect(edits[0].editedByName).toBe("Tech");
    expect(edits[0].changes).toEqual([{ field: "deviceName", from: "was-a", to: "LAPTOP-007" }]);
  });

  it("writes no history for an item already holding its target name", async () => {
    const a = await mkItem("R15", "LAPTOP-001");
    const res = await renameItems([a.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 0, unchanged: 1, skipped: 0 });
    expect(await prisma.itemEdit.count()).toBe(0);
  });

  it("bumps updatedAt on every renamed row", async () => {
    // `@updatedAt` is a Prisma CLIENT feature, not a DB default or trigger, so
    // the batched $executeRaw has to set the column itself. Without that a
    // renamed row keeps its old stamp and claims it never changed — silently,
    // since nothing reads the column today.
    const a = await mkItem("R17", "was-a");
    const b = await mkItem("R18", "was-b");
    const before = new Map(
      (await prisma.item.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, updatedAt: true } }))
        .map((r) => [r.id, r.updatedAt] as const),
    );

    await renameItems([a.id, b.id], "LAPTOP", "001", editor());

    const after = await prisma.item.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { id: true, updatedAt: true },
    });
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.updatedAt.getTime()).toBeGreaterThan(before.get(row.id)!.getTime());
    }
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(renameItems(ids, "X", "001", editor())).rejects.toMatchObject({ code: "TOO_MANY" });
  });

  it("leaves mdmProposedName alone, so the device stays on the rename worklist", async () => {
    // The flag means "MDM still calls this BE-XXXXXXXXXXXX — fix it in Intune".
    // A local rename does not change what MDM calls it, and clearing the flag
    // here would drop the device off ?needsRename=1 while the real job is
    // outstanding. The importer clears it on its own once MDM agrees.
    const a = await prisma.item.create({
      data: {
        make: "Dell", model: "5540", serialNumber: "R16", deviceName: "BE-2AD6890X7IOL",
        status: "ACTIVE", createdById: editorId, mdmProposedName: "BE-2AD6890X7IOL",
      },
    });
    await renameItems([a.id], "LAPTOP", "001", editor());

    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: a.id } });
    expect(fresh.deviceName).toBe("LAPTOP-001");
    expect(fresh.mdmProposedName).toBe("BE-2AD6890X7IOL");
    // And the history records only the name change, never the flag.
    const edits = await prisma.itemEdit.findMany({ where: { itemId: a.id } });
    expect(edits[0].changes).toEqual([
      { field: "deviceName", from: "BE-2AD6890X7IOL", to: "LAPTOP-001" },
    ]);
  });
});

describe("previewRename", () => {
  it("reports the range, the skip count and any collisions without writing", async () => {
    const a = await mkItem("P1", "a");
    const b = await mkItem("P2", "b");
    await mkItem("P3", "LAPTOP-002");

    const out = await previewRename([a.id, b.id], "LAPTOP", "001");
    expect(out).toEqual({
      count: 2,
      first: "LAPTOP-001",
      last: "LAPTOP-002",
      skipped: 0,
      collisions: [{ name: "LAPTOP-002", serialNumber: "P3" }],
    });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("a");
  });
});
