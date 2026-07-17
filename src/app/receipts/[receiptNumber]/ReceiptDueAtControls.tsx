"use client";
import { useActionState } from "react";
import { setReceiptDueAtAction } from "@/app/admin/actions/receipt-timer";

// Admin-only control on an OPEN receipt: set, extend, or clear the return
// timer. Blank `returnDays` clears it (see setReceiptDueAtAction). Kept
// separate (like NotifyPickupButton/AuditControls) so useActionState's
// client boundary doesn't pull the whole receipt page into the client bundle.
export function ReceiptDueAtControls({ receiptNumber }: { receiptNumber: string }) {
  const [state, action, pending] = useActionState(setReceiptDueAtAction, undefined);

  return (
    <form action={action} className="row" style={{ gap: 8, alignItems: "center" }}>
      <input type="hidden" name="receiptNumber" value={receiptNumber} />
      <input
        className="input"
        style={{ width: "auto", minWidth: 160 }}
        name="returnDays"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="days (blank clears)"
        aria-label="Return by, days from now (blank clears)"
      />
      <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>
        {pending ? "Saving…" : "Update return timer"}
      </button>
      {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
      {state?.ok && <span className="alert-success">Saved.</span>}
    </form>
  );
}
