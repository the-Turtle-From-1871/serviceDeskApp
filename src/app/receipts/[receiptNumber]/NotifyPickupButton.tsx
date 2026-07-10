"use client";
import { useActionState } from "react";
import { notifyPickupAction } from "@/app/actions/receipts";

export function NotifyPickupButton({ receiptNumber, hasCustomerEmail }: { receiptNumber: string; hasCustomerEmail: boolean }) {
  const [state, action, pending] = useActionState(notifyPickupAction, undefined);
  const ok = !!state && "ok" in state && state.ok;
  if (!hasCustomerEmail) {
    return (
      <button type="button" className="btn btn-secondary" disabled title="This customer has no email on file, so they can't be notified by email.">
        Notify customer — items ready for pickup
      </button>
    );
  }
  return (
    <form action={action} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input type="hidden" name="receiptNumber" value={receiptNumber} />
      <button className="btn btn-secondary" type="submit" disabled={pending || ok}>
        {ok ? "Customer notified ✓" : pending ? "Sending…" : "Notify customer — items ready for pickup"}
      </button>
      {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
    </form>
  );
}
