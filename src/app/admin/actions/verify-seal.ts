"use server";
import { requireAdmin } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { manifestFromTransfer } from "@/modules/transfers/seal";
import { verifyCryptographicSeal, CryptoKeyUnavailableError } from "@/lib/crypto";

export type SealStatus = "VALID" | "TAMPERED" | "UNSEALED" | "CANNOT_VERIFY" | "NOT_FOUND";

// Admin-only integrity check: re-derive the canonical manifest from the persisted
// receipt and verify its seal. Read-only; never mutates. requireAdmin re-reads
// role/isActive per request, so a demoted admin can't verify.
export async function verifyReceiptSealAction(receiptNumber: string): Promise<{ status: SealStatus; sealedAt?: string }> {
  await requireAdmin();
  try {
    const t = await getTransferByReceiptNumber(receiptNumber);
    // Existence isn't guaranteed at click time: the 90-day purge (or another admin)
    // can hard-delete a CLOSED receipt while the tab sits open. Report that
    // distinctly rather than mislabeling a deleted receipt as merely "unsealed".
    if (!t) return { status: "NOT_FOUND" };
    if (!t.cryptoSignature || !t.sealedAt) return { status: "UNSEALED" };
    const manifest = manifestFromTransfer(t)!; // non-null: sealedAt is present
    const ok = verifyCryptographicSeal(manifest, t.cryptoSignature);
    return { status: ok ? "VALID" : "TAMPERED", sealedAt: t.sealedAt.toISOString() };
  } catch (e) {
    if (e instanceof CryptoKeyUnavailableError) return { status: "CANNOT_VERIFY" };
    console.error("[verifyReceiptSealAction] verify failed:", e);
    return { status: "CANNOT_VERIFY" };
  }
}
