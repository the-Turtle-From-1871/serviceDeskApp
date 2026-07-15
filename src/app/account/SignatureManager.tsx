"use client";
import { useActionState, useState } from "react";
import { createSignatureAction, deleteSignatureAction } from "@/app/actions/signatures";
import { SignaturePad } from "@/components/SignaturePad";

export type SavedSignature = { id: string; name: string; image: string };

export function SignatureManager({ signatures }: { signatures: SavedSignature[] }) {
  const [state, action, pending] = useActionState(createSignatureAction, undefined);
  const [drawn, setDrawn] = useState("");
  // Bumped on a successful add to remount SignaturePad (fresh canvas + fresh
  // internal `dataUrl`), so stale ink from the previous drawing can't survive
  // under a newly-typed name.
  const [padKey, setPadKey] = useState(0);

  // "Storing information from previous renders" pattern (see
  // ItemDetailsCard's identical use for the same reason): compared on `state`
  // IDENTITY, not a derived boolean, and only written when it changes from the
  // previous render — a guarded render-time write, not the unconditional kind
  // react-hooks/set-state-in-render flags. useActionState returns the SAME
  // object across re-renders until a new submit resolves, so this fires once
  // per successful submit rather than on every render (a boolean dep would
  // fire forever once `ok` was ever true). Do NOT replace this with a
  // useEffect + eslint-disable — the repo lints that as an error.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state && "ok" in state && state.ok) {
      setDrawn("");
      setPadKey((k) => k + 1);
    }
  }

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
        <SignaturePad key={padKey} name="image" onChange={setDrawn} />
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
