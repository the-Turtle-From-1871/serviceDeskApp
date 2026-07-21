"use client";
import { useState, useTransition } from "react";
import { verifyReceiptSealAction, type SealStatus } from "@/app/admin/actions/verify-seal";

// Admin-only control (rendered only for admins on the receipt page). Verifies the
// stored seal and shows the result. Kept a separate client component so the
// client boundary doesn't pull the whole receipt page into the bundle
// (mirrors ReceiptDueAtControls / NotifyPickupButton).
const LABELS: Record<SealStatus, string> = {
  VALID: "Seal valid — the receipt is intact.",
  TAMPERED: "SEAL INVALID — a sealed field was altered.",
  UNSEALED: "No seal on this receipt.",
  CANNOT_VERIFY: "Can't verify right now — try again, or check the server signing-key configuration.",
  NOT_FOUND: "Receipt no longer exists — refresh the page.",
};

export function ReceiptSealVerify({ receiptNumber }: { receiptNumber: string }) {
  const [result, setResult] = useState<{ status: SealStatus; sealedAt?: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={() => start(async () => setResult(await verifyReceiptSealAction(receiptNumber)))}
      >
        {pending ? "Verifying…" : "Verify seal"}
      </button>
      {result && (
        <span role="status" className={result.status === "VALID" ? "alert-success" : "alert-error"}>
          {LABELS[result.status]}
          {result.sealedAt ? ` (sealed ${new Date(result.sealedAt).toLocaleString()})` : ""}
        </span>
      )}
    </div>
  );
}
