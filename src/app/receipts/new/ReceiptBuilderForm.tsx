"use client";
import { Fragment, useActionState, useState } from "react";
import { createReceiptAction } from "@/app/actions/receipts";
import { SignaturePad } from "@/components/SignaturePad";
import { TechnicianSignatureField, type PickableSignature } from "@/components/TechnicianSignatureField";
import { PhoneInput } from "@/components/PhoneInput";
import { ContactCombobox } from "@/components/ContactCombobox";
import type { ContactOption } from "@/modules/contacts/contact-match";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };
export type BuilderItem = { serialNumber: string; itemId: string };
export type BuilderLine = { make: string; model: string; items: BuilderItem[]; defaultQty: number };

function PartyFields({ role, prefill, isDcsim, onIsDcsimChange, hideName, name, onNameChange, contacts }: {
  role: "sender" | "receiver";
  prefill?: Prefill;
  isDcsim: boolean;
  onIsDcsimChange: (v: boolean) => void;
  hideName?: boolean;
  name: string;
  onNameChange: (v: string) => void;
  // The contact book. Passed to both parties: a sender is an outside person too
  // whenever equipment is being handed back, and they are exactly who the book
  // holds. Optional so a caller can still render a party without the book.
  contacts?: ContactOption[];
}) {
  const cap = role === "sender" ? "Sender" : "Recipient";

  // LIFTED from `defaultValue` (uncontrolled) so picking a contact can drive all
  // four at once — same reasoning as `name` above and ServiceControls' `note`
  // below.
  //
  // This deliberately changes DCSIM-toggle behavior for BOTH parties, not just
  // the receiver: these four used to be uncontrolled inputs INSIDE the
  // `{!isDcsim && ...}` block, so toggling DCSIM off and back on remounted them
  // and silently discarded whatever had been typed. The state now lives above
  // that block, so edits survive the round-trip. That is the same bug `name` and
  // `note` were already lifted to fix, so the four now match them rather than
  // being the last fields that still lose your work.
  const [rank, setRank] = useState(prefill?.rank ?? "");
  const [unit, setUnit] = useState(prefill?.unit ?? "");
  const [contact, setContact] = useState(prefill?.contact ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");

  // Missing optionals fill as "", leaving the existing `required` validation to
  // prompt: an incomplete contact degrades to a partly-filled form, never a
  // blocked one. Every field stays editable — a pick is a starting point.
  const onPick = (c: ContactOption) => {
    onNameChange(`${c.firstName} ${c.lastName}`);
    setRank(c.rank ?? "");
    setUnit(c.unit ?? "");
    setContact(c.contactNumber ?? "");
    setEmail(c.email);
  };

  // Gated on DCSIM, not on role: the book holds outside people, and either party
  // can be one — an outside recipient being issued kit, or an outside sender
  // handing it back. A DCSIM party is our own technician (account + saved-
  // signature picker), and the four fields below aren't even rendered for them,
  // so the book never applies there.
  const showCombobox = contacts !== undefined && !isDcsim;

  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => onIsDcsimChange(e.target.checked)} />
        This side is DCSIM
      </label>
      {/* Hidden while a saved signature is picked: the name is taken from that
          signature server-side, so an editable field here could only disagree
          with the ink. Not rendered (rather than disabled) so nothing posts.
          The value is LIFTED (like ServiceControls' note below) rather than left
          uncontrolled: hiding unmounts the input, and an uncontrolled one would
          lose whatever was typed, then remount blank. */}
      {!hideName && (
        // Capped: this field is outside .form-grid, so on the wide builder page
        // it would otherwise stretch to the full ~1190px card.
        <div className="field" style={{ maxWidth: 360 }}>
          <label className="label" htmlFor={`${role}-name`}>{isDcsim ? "DCSIM technician name" : "Name"}</label>
          {showCombobox ? (
            <ContactCombobox
              id={`${role}-name`}
              name={`${role}Name`}
              contacts={contacts}
              value={name}
              onValueChange={onNameChange}
              onPick={onPick}
            />
          ) : (
            <input id={`${role}-name`} className="input" name={`${role}Name`} value={name} onChange={(e) => onNameChange(e.target.value)} required />
          )}
        </div>
      )}
      {!isDcsim && (
        <div className="form-grid form-grid-fluid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} value={rank} onChange={(e) => setRank(e.target.value)} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} value={unit} onChange={(e) => setUnit(e.target.value)} required /></div>
          <div className="field"><label className="label">Contact number</label><PhoneInput name={`${role}Contact`} value={contact} onChange={setContact} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
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
  // One horizontal row, not a stack-sm column: the checkbox, the type, and the
  // note sit inline so an item occupies a single table row on a desktop. `.row`
  // still wraps, so a narrow screen stacks them as before.
  return (
    <div className="row" style={{ gap: 8 }}>
      <label className="row" style={{ gap: 6, whiteSpace: "nowrap" }}>
        <input
          type="checkbox"
          name={`service[${itemId}][needs]`}
          checked={needs}
          onChange={(e) => setNeeds(e.target.checked)}
        />
        Needs service?
      </label>
      {needs && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
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
            // width:auto overrides the global `.input { width: 100% }`, which
            // would otherwise claim a whole flex line and push the type select
            // onto its own row regardless of how much space the column has.
            <input
              className="input"
              style={{ width: "auto", flex: "1 1 200px", minWidth: 200 }}
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

export function ReceiptBuilderForm({ itemIds, lines, senderPrefill, signatures, contacts }: { itemIds: string[]; lines: BuilderLine[]; senderPrefill?: Prefill; signatures: PickableSignature[]; contacts: ContactOption[] }) {
  const [state, action, pending] = useActionState(createReceiptAction, undefined);
  const [senderIsDcsim, setSenderIsDcsim] = useState(senderPrefill?.isDcsim ?? false);
  const [receiverIsDcsim, setReceiverIsDcsim] = useState(false);
  const [senderName, setSenderName] = useState(senderPrefill?.name ?? "");
  const [receiverName, setReceiverName] = useState("");
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
      {/* The sender gets the book too. `senderPrefill` (the last receiver of these
          items) still seeds the fields on load — a pick just overrides it, which is
          what you want when the items are coming back from someone other than
          whoever the receipt says last held them. */}
      <PartyFields role="sender" prefill={senderPrefill} isDcsim={senderIsDcsim} onIsDcsimChange={setSenderIsDcsim} name={senderName} onNameChange={setSenderName} contacts={contacts} />
      <PartyFields role="receiver" isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} name={receiverName} onNameChange={setReceiverName} contacts={contacts} />
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
