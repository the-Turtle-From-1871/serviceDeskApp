"use client";
import { Fragment, useActionState, useState } from "react";
import { createReceiptAction } from "@/app/actions/receipts";
import { SignaturePad } from "@/components/SignaturePad";
import { TechnicianSignatureField, type PickableSignature } from "@/components/TechnicianSignatureField";
import { PhoneInput } from "@/components/PhoneInput";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };
export type BuilderItem = { serialNumber: string; itemId: string };
export type BuilderLine = { make: string; model: string; items: BuilderItem[]; defaultQty: number };

function PartyFields({ role, prefill, isDcsim, onIsDcsimChange, hideName }: {
  role: "sender" | "receiver";
  prefill?: Prefill;
  isDcsim: boolean;
  onIsDcsimChange: (v: boolean) => void;
  hideName?: boolean;
}) {
  const cap = role === "sender" ? "Sender" : "Recipient";
  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => onIsDcsimChange(e.target.checked)} />
        This side is DCSIM
      </label>
      {/* Hidden while a saved signature is picked: the name is taken from that
          signature server-side, so an editable field here could only disagree
          with the ink. Not rendered (rather than disabled) so nothing posts. */}
      {!hideName && (
        <div className="field">
          <label className="label">{isDcsim ? "DCSIM technician name" : "Name"}</label>
          <input className="input" name={`${role}Name`} defaultValue={prefill?.name ?? ""} required />
        </div>
      )}
      {!isDcsim && (
        <div className="form-grid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} defaultValue={prefill?.rank ?? ""} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} defaultValue={prefill?.unit ?? ""} required /></div>
          <div className="field"><label className="label">Contact number</label><PhoneInput name={`${role}Contact`} defaultValue={prefill?.contact} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} defaultValue={prefill?.email ?? ""} required /></div>
        </div>
      )}
    </fieldset>
  );
}

// Per-serial "Needs service?" capture. Checking it reveals the service type;
// choosing "Other" reveals a custom-message input. Field names are namespaced by
// itemId so parseServiceMap can reconstruct the per-item selection server-side.
function ServiceControls({ itemId }: { itemId: string }) {
  const [needs, setNeeds] = useState(false);
  const [type, setType] = useState("REIMAGE");
  // Lifted (rather than left uncontrolled on the conditionally-rendered input)
  // so a typed note survives unchecking/rechecking "Needs service?".
  const [note, setNote] = useState("");
  return (
    <div className="stack-sm">
      <label className="row" style={{ gap: 6 }}>
        <input
          type="checkbox"
          name={`service[${itemId}][needs]`}
          checked={needs}
          onChange={(e) => setNeeds(e.target.checked)}
        />
        Needs service?
      </label>
      {needs && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <select
            className="select"
            style={{ width: "auto", minWidth: 130 }}
            name={`service[${itemId}][type]`}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Service type"
          >
            {SERVICE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {type === "OTHER" && (
            <input
              className="input"
              style={{ minWidth: 200 }}
              name={`service[${itemId}][note]`}
              placeholder="Describe the service needed"
              aria-label="Describe the service needed"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
            />
          )}
        </div>
      )}
    </div>
  );
}

export function ReceiptBuilderForm({ itemIds, lines, senderPrefill, signatures }: { itemIds: string[]; lines: BuilderLine[]; senderPrefill?: Prefill; signatures: PickableSignature[] }) {
  const [state, action, pending] = useActionState(createReceiptAction, undefined);
  const [senderIsDcsim, setSenderIsDcsim] = useState(senderPrefill?.isDcsim ?? false);
  const [receiverIsDcsim, setReceiverIsDcsim] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  // Clearing the pick here is load-bearing, not hygiene. TechnicianSignatureField
  // UNMOUNTS when DCSIM is unchecked, so it never reports null on the way out.
  // Without this, pick -> uncheck -> recheck remounts it with a fresh selection
  // (posting no signatureId) while a stale pickedId keeps the name field hidden,
  // and the form posts an empty receiverName that fails validation with no
  // visible field to fix.
  const onReceiverDcsimChange = (v: boolean) => {
    setReceiverIsDcsim(v);
    if (!v) setPickedId(null);
  };
  const hideReceiverName = receiverIsDcsim && pickedId !== null;

  if (receipt) {
    return (
      <div className="card stack-sm">
        <h2 className="page-title">Receipt {receipt} created</h2>
        <div className="row">
          <a className="btn btn-secondary" href={`/receipts/${receipt}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Preview PDF</a>
          <a className="btn btn-primary" href={`/receipts/${receipt}/pdf`}>Download PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${receipt}`}>View receipt</a>
          <a className="btn btn-ghost" href="/items">Back to items</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      {itemIds.map((id) => <input key={id} type="hidden" name="itemId" value={id} />)}
      <fieldset className="card stack-sm">
        <legend className="card__title">Items ({lines.length} {lines.length === 1 ? "row" : "rows"})</legend>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Item</th><th>Serial</th><th>Service</th><th>Auth</th><th>Issued</th></tr></thead>
            <tbody>
              {lines.map((ln, i) => (
                <Fragment key={ln.items[0].itemId}>
                  <tr>
                    <td>{i + 1}</td>
                    <td>{ln.make} {ln.model}
                      <input type="hidden" name={`line[${i}][make]`} value={ln.make} />
                      <input type="hidden" name={`line[${i}][model]`} value={ln.model} />
                    </td>
                    <td className="mono">{ln.items[0].serialNumber}</td>
                    <td><ServiceControls itemId={ln.items[0].itemId} /></td>
                    <td rowSpan={ln.items.length}><input className="input" style={{ width: 72 }} type="number" min={1} name={`line[${i}][qtyAuth]`} defaultValue={ln.defaultQty} required /></td>
                    <td rowSpan={ln.items.length}><input className="input" style={{ width: 72 }} type="number" min={1} name={`line[${i}][qtyIssued]`} defaultValue={ln.defaultQty} required /></td>
                  </tr>
                  {ln.items.slice(1).map((it) => (
                    <tr key={it.itemId}>
                      <td></td>
                      <td></td>
                      <td className="mono">{it.serialNumber}</td>
                      <td><ServiceControls itemId={it.itemId} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>
      <PartyFields role="sender" prefill={senderPrefill} isDcsim={senderIsDcsim} onIsDcsimChange={setSenderIsDcsim} />
      <PartyFields role="receiver" isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} />
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature{receiverIsDcsim ? " (DCSIM)" : ""}</legend>
        {receiverIsDcsim ? (
          // A DCSIM recipient is our own technician at the desk, so they may pick
          // their saved signature. An outside recipient must always draw in person.
          <TechnicianSignatureField
            name="receiverSignature"
            signatures={signatures}
            label="Who received it?"
            drawHint={null}
            onPickedChange={setPickedId}
          />
        ) : (
          <SignaturePad name="receiverSignature" />
        )}
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Creating…" : "Create hand receipt"}</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
