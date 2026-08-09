import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  // recordAudit runs create + item.update inside a $transaction; the other reads
  // hit the top-level client. AUDIT_CREATED is defined inside the factory (vi.mock
  // is hoisted, so it can't reference an outer const).
  const AUDIT_CREATED = new Date("2026-07-21T12:00:00.000Z");
  const tx = {
    itemAudit: { create: vi.fn(async () => ({ id: "a1", createdAt: AUDIT_CREATED })) },
    item: { update: vi.fn(async () => ({})) },
    // putSignatureAsset writes the deduplicated blob through a raw
    // INSERT … ON CONFLICT DO NOTHING (see signature-asset.service).
    $executeRaw: vi.fn(async () => 1),
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
import { signatureSha256 } from "@/lib/signature-hash";

const SIG = "data:image/png;base64,AAA";

beforeEach(() => vi.clearAllMocks());

describe("recordAudit", () => {
  it("creates one ItemAudit row and updates the item's lastAuditedAt to its date", async () => {
    const res = await recordAudit({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: SIG,
    });

    const createArg = vi.mocked(__tx.itemAudit.create).mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      itemId: "i1",
      auditedById: "u1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureSha: signatureSha256(SIG),
    });

    // The denormalized sort key is set to the newly-created audit's timestamp.
    const updateArg = vi.mocked(__tx.item.update).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "i1" });
    expect(updateArg.data).toEqual({ lastAuditedAt: res.createdAt });
  });

  it("stores the signature by reference, never inline on the audit row", async () => {
    await recordAudit({
      itemId: "i1", auditedById: "u1", auditedByName: "Sgt Admin",
      signerName: "SFC Tech", signatureImage: SIG,
    });
    // The ~12 KB blob is what this table used to carry per row; it must not come
    // back. Only the 64-char content address belongs on ItemAudit.
    const createArg = vi.mocked(__tx.itemAudit.create).mock.calls[0][0];
    expect(createArg.data).not.toHaveProperty("signatureImage");
    expect(JSON.stringify(createArg.data)).not.toContain(SIG);
  });

  it("writes the asset inside the SAME transaction as the audit row", async () => {
    await recordAudit({
      itemId: "i1", auditedById: "u1", auditedByName: "Sgt Admin",
      signerName: "SFC Tech", signatureImage: SIG,
    });
    // The FK on ItemAudit.signatureSha has to see the asset, and a rolled-back
    // audit must not leave one behind — so the insert goes through the tx client,
    // never the global prisma.
    expect(__tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(__tx.$executeRaw).mock.calls[0]).toContain(SIG);
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
    expect(arg.select).not.toHaveProperty("signatureAsset");
  });
});

describe("getAuditSignature", () => {
  it("rehydrates the deduplicated image for one audit", async () => {
    vi.mocked(prisma.itemAudit.findUnique).mockResolvedValueOnce({ signatureAsset: { image: SIG } } as never);
    const img = await getAuditSignature("a1");
    // Callers still get a data URL — the dedup is invisible above this layer.
    expect(img).toBe(SIG);
    const arg = vi.mocked(prisma.itemAudit.findUnique).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "a1" });
    expect(arg.select).toEqual({ signatureAsset: { select: { image: true } } });
  });

  it("returns null when the audit no longer exists", async () => {
    vi.mocked(prisma.itemAudit.findUnique).mockResolvedValueOnce(null);
    expect(await getAuditSignature("gone")).toBeNull();
  });
});
