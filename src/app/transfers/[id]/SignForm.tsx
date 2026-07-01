"use client";
import { useActionState } from "react";
import { acceptTransferAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

export function SignForm({ transferId }: { transferId: string }) {
  const [state, action, pending] = useActionState(acceptTransferAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="transferId" value={transferId} />
      <label className="label">Draw your signature to accept custody</label>
      <SignaturePad name="signature" />
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      <div>
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Submitting…" : "Accept custody"}
        </button>
      </div>
    </form>
  );
}
