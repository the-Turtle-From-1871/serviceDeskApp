import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  // recordAudit runs create + item.update inside a $transaction; the other reads
  // hit the top-level client. AUDIT_CREATED is defined inside the factory (vi.mock
  // is hoisted, so it can't reference an outer const).
  const AUDIT_CREATED = new Date("2026-07-21T12:00:00.000Z");
  const tx = {
    itemAudit: { create: vi.fn(async () => ({ id: "a1", createdAt: AUDIT_CREATED })) },
    item: { update: vi.fn(async () => ({})) },
  };
  return {
    default: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      itemAudit: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
      },
    },
    __tx: tx,
  };
});

import prisma from "@/lib/prisma";
// @ts-expect-error test-only export
import { __tx } from "@/lib/prisma";
import { recordAudit, getAuditsForItem, getAuditSignature } from "./audit.service";

beforeEach(() => vi.clearAllMocks());

describe("recordAudit", () => {
  it("creates one ItemAudit row and updates the item's lastAuditedAt to its date", async () => {
    const res = await recordAudit({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });

    const createArg = vi.mocked(__tx.itemAudit.create).mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });

    // The denormalized sort key is set to the newly-created audit's timestamp.
    const updateArg = vi.mocked(__tx.item.update).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "i1" });
    expect(updateArg.data).toEqual({ lastAuditedAt: res.createdAt });
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
