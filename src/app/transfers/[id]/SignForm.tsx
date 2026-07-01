"use client";
import { useActionState } from "react";
import { acceptTransferAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

export function SignForm({ transferId }: { transferId: string }) {
  const [state, action, pending] = useActionState(acceptTransferAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="transferId" value={transferId} />
      <p>Draw your signature to accept custody:</p>
      <SignaturePad name="signature" />
      {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
      <button disabled={pending} type="submit">{pending ? "Submitting…" : "Accept custody"}</button>
    </form>
  );
}
