"use client";
import { useActionState, useState } from "react";
import { saveSignatureAction } from "@/app/actions/account";
import { SignaturePad } from "@/components/SignaturePad";

export function SignatureSettings({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(saveSignatureAction, undefined);
  const [drawn, setDrawn] = useState("");
  const saved = state && "ok" in state && state.ok;

  return (
    <div className="stack-sm">
      {current && (
        <div className="stack-sm">
          <div className="subtle">Current saved signature:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current} alt="Your saved signature" className="sig-preview" />
        </div>
      )}
      <form action={action} className="stack-sm">
        <div className="subtle">{current ? "Draw a new signature to replace it:" : "Draw your signature:"}</div>
        <SignaturePad name="signature" onChange={setDrawn} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={pending || drawn.length === 0}>
            {pending ? "Saving…" : "Save signature"}
          </button>
        </div>
      </form>
      {current && (
        <form action={action}>
          <input type="hidden" name="clear" value="1" />
          <button className="btn btn-secondary btn-sm" type="submit" disabled={pending}>Remove saved signature</button>
        </form>
      )}
      {saved && <p className="alert-success">Signature updated.</p>}
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
    </div>
  );
}
