import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    itemAudit: {
      create: vi.fn(async () => ({ id: "a1" })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      groupBy: vi.fn(async () => []),
    },
  },
}));

import prisma from "@/lib/prisma";
import { recordAudit, getAuditsForItem, getAuditSignature, getLatestAuditMap } from "./audit.service";

beforeEach(() => vi.clearAllMocks());

describe("recordAudit", () => {
  it("creates one ItemAudit row from the input", async () => {
    await recordAudit({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
    const arg = vi.mocked(prisma.itemAudit.create).mock.calls[0][0];
    expect(arg.data).toMatchObject({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
  });
});

describe("getAuditsForItem", () => {
  it("queries the item's audits newest-first, WITHOUT the signature blob", async () => {
    await getAuditsForItem("i1");
    const arg = vi.mocked(prisma.itemAudit.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    // The detail-page history log renders only id/signer/date; the signature
    // image is fetched on demand, so it must NOT be shipped in this payload.
    expect(arg.select).toEqual({ id: true, signerName: true, createdAt: true });
    expect(arg.select).not.toHaveProperty("signatureImage");
  });
});

describe("getAuditSignature", () => {
  it("selects only the signature image for one audit", async () => {
    vi.mocked(prisma.itemAudit.findUnique).mockResolvedValueOnce({ signatureImage: "data:image/png;base64,AAA" } as never);
    const img = await getAuditSignature("a1");
    expect(img).toBe("data:image/png;base64,AAA");
    const arg = vi.mocked(prisma.itemAudit.findUnique).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "a1" });
    expect(arg.select).toEqual({ signatureImage: true });
  });

  it("returns null when the audit no longer exists", async () => {
    vi.mocked(prisma.itemAudit.findUnique).mockResolvedValueOnce(null);
    expect(await getAuditSignature("gone")).toBeNull();
  });
});

describe("getLatestAuditMap", () => {
  it("returns an empty map for no ids without querying", async () => {
    const map = await getLatestAuditMap([]);
    expect(map.size).toBe(0);
    expect(prisma.itemAudit.groupBy).not.toHaveBeenCalled();
  });

  it("maps each itemId to its newest audit date", async () => {
    const d = new Date("2026-01-01T00:00:00Z");
    vi.mocked(prisma.itemAudit.groupBy).mockResolvedValueOnce([
      { itemId: "i1", _max: { createdAt: d } },
      { itemId: "i2", _max: { createdAt: null } },
    ] as never);
    const map = await getLatestAuditMap(["i1", "i2"]);
    expect(map.get("i1")).toEqual(d);
    expect(map.has("i2")).toBe(false);
  });
});
