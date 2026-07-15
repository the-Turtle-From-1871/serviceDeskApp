"use client";
import { useActionState, useState } from "react";
import { createSignatureAction, deleteSignatureAction } from "@/app/actions/signatures";
import { SignaturePad } from "@/components/SignaturePad";

export type SavedSignature = { id: string; name: string; image: string };

export function SignatureManager({ signatures }: { signatures: SavedSignature[] }) {
  const [state, action, pending] = useActionState(createSignatureAction, undefined);
  const [drawn, setDrawn] = useState("");

  return (
    <div className="stack-sm">
      {signatures.length === 0 ? (
        <p className="subtle">No saved signatures yet. Add one below.</p>
      ) : (
        <ul className="stack-sm">
          {signatures.map((s) => (
            <li key={s.id} className="row">
              <div>
                <div><strong>{s.name}</strong></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.image} alt={`Signature for ${s.name}`} className="sig-preview" />
              </div>
              <span className="spacer" />
              <form action={deleteSignatureAction}>
                <input type="hidden" name="id" value={s.id} />
                <button type="submit" className="btn btn-ghost btn-sm">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="stack-sm">
        <div className="field">
          <label className="label" htmlFor="sig-name">Technician name<span className="req"> *</span></label>
          <input id="sig-name" className="input" name="name" placeholder="e.g. SGT Smith" required />
        </div>
        <SignaturePad name="image" onChange={setDrawn} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={pending || drawn.length === 0}>
            {pending ? "Saving…" : "Add signature"}
          </button>
        </div>
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        {state && "ok" in state && state.ok && <p className="alert-success">Signature added.</p>}
      </form>
    </div>
  );
}
