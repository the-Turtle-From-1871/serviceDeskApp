"use client";
import { useActionState } from "react";
import { notifyPickupAction } from "@/app/actions/receipts";

export function NotifyPickupButton({ receiptNumber }: { receiptNumber: string }) {
  const [state, action, pending] = useActionState(notifyPickupAction, undefined);
  const ok = !!state && "ok" in state && state.ok;
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
