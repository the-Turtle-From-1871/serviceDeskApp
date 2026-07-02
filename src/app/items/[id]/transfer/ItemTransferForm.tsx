"use client";
import { useActionState, useState } from "react";
import { createTransferAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };

function PartyFields({ role, prefill }: { role: "sender" | "receiver"; prefill?: Prefill }) {
  const [isDcsim, setIsDcsim] = useState(prefill?.isDcsim ?? false);
  const cap = role === "sender" ? "Sender" : "Recipient";
  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => setIsDcsim(e.target.checked)} />
        This side is DCSIM
      </label>
      <div className="field">
        <label className="label">{isDcsim ? "DCSIM technician name" : "Name"}</label>
        <input className="input" name={`${role}Name`} defaultValue={prefill?.name ?? ""} required />
      </div>
      {!isDcsim && (
        <div className="form-grid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} defaultValue={prefill?.rank ?? ""} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} defaultValue={prefill?.unit ?? ""} required /></div>
          <div className="field"><label className="label">Contact number</label><input className="input" name={`${role}Contact`} defaultValue={prefill?.contact ?? ""} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} defaultValue={prefill?.email ?? ""} required /></div>
        </div>
      )}
    </fieldset>
  );
}

export function ItemTransferForm({ itemId, senderPrefill }: { itemId: string; senderPrefill?: Prefill }) {
  const [state, action, pending] = useActionState(createTransferAction, undefined);
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  if (receipt) {
    return (
      <div className="card stack-sm">
        <h2 className="page-title">Receipt {receipt} created</h2>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${receipt}/pdf`}>Download PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${receipt}`}>View receipt</a>
          <a className="btn btn-ghost" href="/items">Back to items</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <input type="hidden" name="itemId" value={itemId} />
      <PartyFields role="sender" prefill={senderPrefill} />
      <PartyFields role="receiver" />
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature</legend>
        <SignaturePad name="receiverSignature" />
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Creating…" : "Create hand receipt"}</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
