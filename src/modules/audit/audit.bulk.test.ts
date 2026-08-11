import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { recordAudits } from "./audit.service";
import { resetDb } from "../../../tests/helpers/db";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

async function mkItem(serial: string, createdById: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  // Item.createdById is a required FK, so every fixture needs a creator.
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName: `dev-${serial}`, status, createdById },
  });
}

async function mkUser() {
  return prisma.user.create({
    data: { name: "Auditor", email: `a${Date.now()}@unit.mil`, passwordHash: "x", role: "ADMIN" },
  });
}

describe("recordAudits", () => {
  let userId: string;
  beforeEach(async () => {
    // DB-backed test on the shared test database, like items.bulk.test.ts —
    // reset first so fixed literal serials (BULKA1…) can't collide with a
    // leftover row from a previous run.
    await resetDb();
    userId = (await mkUser()).id;
  });

  it("writes one audit per item and ONE shared signature asset", async () => {
    const items = await Promise.all([mkItem("BULKA1", userId), mkItem("BULKA2", userId), mkItem("BULKA3", userId)]);
    const res = await recordAudits({
      itemIds: items.map((i) => i.id),
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });

    expect(res).toEqual({ updated: 3, skipped: 0 });

    const audits = await prisma.itemAudit.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(audits).toHaveLength(3);
    expect(new Set(audits.map((a) => a.signatureSha)).size).toBe(1);
  });

  it("stamps lastAuditedAt with the SAME instant as the audit rows", async () => {
    const item = await mkItem("BULKA4", userId);
    await recordAudits({
      itemIds: [item.id],
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });
    const audit = await prisma.itemAudit.findFirstOrThrow({ where: { itemId: item.id } });
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.lastAuditedAt?.getTime()).toBe(audit.createdAt.getTime());
  });

  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("BULKA5", userId);
    const retired = await mkItem("BULKA6", userId, "RETIRED");
    const res = await recordAudits({
      itemIds: [active.id, retired.id],
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });
    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(await prisma.itemAudit.count({ where: { itemId: retired.id } })).toBe(0);
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      recordAudits({ itemIds: ids, auditedById: userId, auditedByName: "A", signerName: "S", signatureImage: PNG }),
    ).rejects.toMatchObject({ code: "TOO_MANY" });
  });

  it("is a no-op for an empty list", async () => {
    const res = await recordAudits({
      itemIds: [], auditedById: userId, auditedByName: "A", signerName: "S", signatureImage: PNG,
    });
    expect(res).toEqual({ updated: 0, skipped: 0 });
  });
});
