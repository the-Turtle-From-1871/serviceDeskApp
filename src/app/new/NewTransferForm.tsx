"use client";
import { useActionState, useState } from "react";
import { createTransferAction, lookupLastHolderAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

type Operator = { rank: string; name: string; unit: string; contact: string; email: string; isAdmin: boolean };
type ItemOption = { id: string; label: string };
type Prefill = Partial<Operator> & { isDcsim?: boolean };

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

export function NewTransferForm({ items, operator }: { items: ItemOption[]; operator: Operator }) {
  const [state, action, pending] = useActionState(createTransferAction, undefined);
  const [itemMode, setItemMode] = useState<"existing" | "new">(items.length ? "existing" : "new");
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  // Sender pre-fill precedence: item's last-known holder (fetched on select) >
  // the logged-in non-admin operator's own account > empty. The sender fieldset
  // is remounted via `senderKey` so its uncontrolled inputs re-apply defaults.
  const [senderPrefill, setSenderPrefill] = useState<Prefill | undefined>(operator.isAdmin ? undefined : operator);
  const [senderKey, setSenderKey] = useState(0);

  async function onItemSelected(itemId: string) {
    if (!itemId) return;
    let last: Awaited<ReturnType<typeof lookupLastHolderAction>> = null;
    try {
      last = await lookupLastHolderAction(itemId);
    } catch (err) {
      console.error("[NewTransferForm] lookupLastHolderAction failed:", err);
    }
    if (last) {
      setSenderPrefill(
        last.isDcsim
          ? { isDcsim: true, name: last.name }
          : { isDcsim: false, name: last.name, rank: last.rank ?? "", unit: last.unit ?? "", contact: last.contact ?? "", email: last.email ?? "" }
      );
    } else {
      setSenderPrefill(operator.isAdmin ? undefined : operator);
    }
    setSenderKey((k) => k + 1);
  }

  if (receipt) {
    return (
      <div className="card stack-sm">
        <h2 className="page-title">Receipt {receipt} created</h2>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${receipt}/pdf`}>Download PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${receipt}`}>View receipt</a>
          <a className="btn btn-ghost" href="/new">New transfer</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <fieldset className="card stack-sm">
        <legend className="card__title">Item</legend>
        <div className="row">
          <label className="row"><input type="radio" name="itemMode" value="existing" checked={itemMode === "existing"} onChange={() => setItemMode("existing")} /> Existing</label>
          <label className="row"><input type="radio" name="itemMode" value="new" checked={itemMode === "new"} onChange={() => setItemMode("new")} /> Log new item</label>
        </div>
        {itemMode === "existing" ? (
          <select className="select" name="itemId" defaultValue="" required onChange={(e) => onItemSelected(e.target.value)}>
            <option value="" disabled>Select an item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        ) : (
          <div className="form-grid">
            <div className="field"><label className="label">Make</label><input className="input" name="make" required /></div>
            <div className="field"><label className="label">Model</label><input className="input" name="model" required /></div>
            <div className="field"><label className="label">Serial number</label><input className="input" name="serialNumber" required /></div>
            <div className="field"><label className="label">Home unit</label><input className="input" name="homeUnit" /></div>
            <div className="field"><label className="label">Notes (optional)</label><input className="input" name="notes" /></div>
          </div>
        )}
      </fieldset>

      <PartyFields key={senderKey} role="sender" prefill={senderPrefill} />
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
