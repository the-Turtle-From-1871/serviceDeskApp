import "server-only";
import type { ReceiptWithLines } from "./transfers.service";

export type ManifestInput = {
  receiptNumber: string;
  actingUserId: string | null;
  sealedAt: Date;
  receiver: { isDcsim: boolean; name: string; rank: string | null; unit: string | null; contact: string | null; email: string | null };
  receiverSignature: string;
  items: { serialNumber: string; make: string; model: string }[];
};

/** Normalized, order-stable manifest. Items are sorted by serialNumber (unique
 *  per receipt => total order) so the array is deterministic regardless of DB
 *  row order; canonicalize() then sorts object keys. Sign and verify BOTH build
 *  the manifest here so they can never drift. */
export function buildHandoffManifest(input: ManifestInput) {
  return {
    receiptNumber: input.receiptNumber,
    actingUserId: input.actingUserId,
    sealedAt: input.sealedAt.toISOString(),
    receiver: { ...input.receiver },
    receiverSignature: input.receiverSignature,
    items: [...input.items].sort((a, b) => a.serialNumber.localeCompare(b.serialNumber)),
  };
}

/** Reconstruct the manifest from a persisted receipt. Field mapping mirrors what
 *  createTransfer passed in. Returns null if the row was never sealed. */
export function manifestFromTransfer(t: ReceiptWithLines) {
  if (!t.sealedAt) return null;
  return buildHandoffManifest({
    receiptNumber: t.receiptNumber,
    actingUserId: t.createdByUserId ?? null,
    sealedAt: t.sealedAt,
    receiver: {
      isDcsim: t.receiverIsDcsim,
      name: t.receiverName,
      rank: t.receiverRank ?? null,
      unit: t.receiverUnit ?? null,
      contact: t.receiverContact ?? null,
      email: t.receiverEmail ?? null,
    },
    receiverSignature: t.receiverSignature,
    items: t.lines.flatMap((ln) => ln.items.map((it) => ({ serialNumber: it.serialNumber, make: ln.make, model: ln.model }))),
  });
}
