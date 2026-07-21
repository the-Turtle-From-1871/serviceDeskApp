"use client";
import { Fragment, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { createReceiptAction } from "@/app/actions/receipts";
import { SignaturePad } from "@/components/SignaturePad";
import { TechnicianSignatureField, type PickableSignature } from "@/components/TechnicianSignatureField";
import { PhoneInput } from "@/components/PhoneInput";
import { ContactCombobox } from "@/components/ContactCombobox";
import type { ContactOption } from "@/modules/contacts/contact-match";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };
import { groupItemsIntoLines, MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW, type LineItem } from "@/modules/transfers/receipt-lines";
import { parseItemScan } from "@/modules/items/scan-url";
import { lookupScannedItem } from "@/app/actions/scan";
import { QrScanner } from "@/components/QrScanner";
import { beep } from "@/lib/beep";

// `holderName` is the item's current holder, used to warn when a scan brings in
// equipment held by someone other than the sender on the form. It rides along
// with the item because groupItemsIntoLines only carries ids and serials.
export type BuilderItem = LineItem & { holderName: string | null };

function PartyFields({ role, prefill, isDcsim, onIsDcsimChange, hideName, name, onNameChange }: {
  role: "sender" | "receiver";
  prefill?: Prefill;
  isDcsim: boolean;
  onIsDcsimChange: (v: boolean) => void;
  hideName?: boolean;
  name: string;
  onNameChange: (v: string) => void;
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
  const showCombobox = !isDcsim;

  // React resets the form after the action settles — including when it settles
  // to an error — and a reset restores every control to its defaultChecked /
  // defaultValue. For a controlled TEXT input React keeps defaultValue in step
  // with value, so the reset is a no-op. It does NOT do the same for a
  // controlled checkbox: defaultChecked stays frozen at its mount value.
  //
  // So a sender that starts DCSIM (its items' last receiver was a technician)
  // and is then unchecked gets silently re-checked by the next failed submit,
  // while React state — and this whole fieldset — still render unchecked. The
  // operator fixes the real error, resubmits, and files a receipt claiming the
  // sender was DCSIM. Keeping defaultChecked in step makes the reset a no-op
  // here too. Verified by ReceiptBuilderForm.test.tsx.
  const dcsimRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dcsimRef.current) dcsimRef.current.defaultChecked = isDcsim;
  }, [isDcsim]);

  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input ref={dcsimRef} type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => onIsDcsimChange(e.target.checked)} />
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
          {/* htmlFor/id on every one: these four were the only labels in the app
              not tied to their input (13 other forms do it), so a screen reader
              announced eight fields here — four per party — as unnamed edit
              boxes. Sighted users saw the labels; the accessibility tree didn't
              have them. ids are namespaced by role, like `${role}-name` above,
              since both parties render this fieldset. */}
          <div className="field"><label className="label" htmlFor={`${role}-rank`}>Rank</label><input id={`${role}-rank`} className="input" name={`${role}Rank`} value={rank} onChange={(e) => setRank(e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor={`${role}-unit`}>Unit</label><input id={`${role}-unit`} className="input" name={`${role}Unit`} value={unit} onChange={(e) => setUnit(e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor={`${role}-contact`}>Contact number</label><PhoneInput id={`${role}-contact`} name={`${role}Contact`} value={contact} onChange={setContact} required /></div>
          <div className="field"><label className="label" htmlFor={`${role}-email`}>Email</label><input id={`${role}-email`} className="input" type="email" name={`${role}Email`} value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        </div>
      )}
    </fieldset>
  );
}

// Controlled by the FORM, not by itself. Two reasons, both load-bearing:
//
// 1. React resets the form after any settled action, including a failed one. An
//    uncontrolled qty snapped a typed value back to its default, so the
//    operator fixed the real error, resubmitted, and filed the wrong count.
//    (Verified by ReceiptBuilderForm.test.tsx.)
// 2. The value must TRACK the line's item count while untouched. Seeding state
//    from defaultQty froze it at mount — fine when the list could not change,
//    wrong the moment a scan can grow a line.
//
// `label` is announced via aria-label: the column's <th> orients a sighted user
// but gives the input no accessible name.
function QtyInput({ name, value, onChange, label }: { name: string; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      className="input"
      style={{ width: 72 }}
      type="number"
      min={1}
      name={name}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required
    />
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
  // Optional per-serial SLA override, in days from when the receipt is filed.
  // Blank leaves parseServiceMap to fall back to the type default (sla.ts).
  const [days, setDays] = useState("");
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
          <input
            className="input"
            style={{ width: "auto", flex: "0 1 160px", minWidth: 140 }}
            name={`service[${itemId}][days]`}
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="SLA days (default by type)"
            aria-label="SLA override days"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))}
          />
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

export function ReceiptBuilderForm({ initialItems, senderPrefill, signatures }: {
  initialItems: BuilderItem[];
  senderPrefill?: Prefill;
  signatures: PickableSignature[];
}) {
  const [state, action, pending] = useActionState(createReceiptAction, undefined);
  // The item list is now the form's own state, seeded from the URL. It must NOT
  // go back to being a prop: re-deriving it from `?items=` on each change would
  // remount this component and discard the drawn signature and every typed
  // field — the exact bug class the comments above already exist to prevent.
  const [items, setItems] = useState<BuilderItem[]>(initialItems);
  const lines = useMemo(() => groupItemsIntoLines(items), [items]);

  // Keep the URL in step so a reload rebuilds the same list. This restores
  // PARITY with today (where items survive a refresh because they come from the
  // URL) rather than adding a feature — and it matters most on the device this
  // targets: iOS Safari evicts background tabs, and a page holding a live
  // camera plus a WASM decoder is a prime candidate. A reload here is the
  // operator switching apps for ten seconds, not fat-fingering refresh.
  //
  // replaceState, NOT pushState: a scan is not a history entry. Back must leave
  // the builder, not un-scan one laptop at a time. Next 16 integrates the
  // native History API with its router — see
  // node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
  useEffect(() => {
    if (items.length === 0) return; // `?items=` empty would notFound() on reload
    window.history.replaceState(null, "", `?items=${items.map((i) => i.itemId).join(",")}`);
  }, [items]);

  const removeItem = (itemId: string) => {
    const removed = items.find((i) => i.itemId === itemId);
    setItems((prev) => prev.filter((i) => i.itemId !== itemId));
    // Drop the qty override for a make/model no longer on the receipt, so
    // removing every item of a type and re-scanning it starts from the live
    // count, not a stale edit. Folded here from a useEffect (which tripped
    // react-hooks/set-state-in-effect); removeItem is the only path that
    // shrinks the list, so this covers every case the effect did.
    if (removed && !items.some((i) => i.itemId !== itemId && i.make === removed.make && i.model === removed.model)) {
      const key = lineKey(removed);
      setQtyEdits((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // A QR sitting in frame decodes many times a second, so the same id inside
  // this window is the camera repeating itself, not a second laptop.
  const lastDecode = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  // Serializes lookups. The decode loop fires onDecode without awaiting, so
  // without this two different ids interleave their read-modify-write of the
  // item list and the second drops the first. One in flight at a time.
  const looking = useRef(false);
  // Mirrors `items` so onDecode reads the LIVE list across its await instead of
  // the snapshot its closure captured. Updated on every render, and eagerly
  // after an append so a second scan landing before the next render still sees
  // the first.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const say = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    beep(kind);
  };

  const holderNote = (holder: string | null) =>
    holder && senderName && holder !== senderName ? ` — held by ${holder}, not ${senderName}` : "";

  // Every refusal KEEPS the camera open: rapid-fire only works if a bad scan is
  // a blip, not a dead end.
  const onDecode = async (text: string) => {
    const id = parseItemScan(text);
    // Rejected client-side, so a stray barcode never costs a round trip.
    if (!id) return say("err", "Not an item code");

    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Time-window dedupe: the same id within 1.5s of the last PROCESSED decode is
    // the camera repeating a QR still in frame. Checked AFTER the in-flight guard
    // and recorded only when we actually proceed — otherwise a decode dropped for
    // concurrency would arm the window against its own retry and suppress a
    // legitimate item for up to 1.5s.
    const now = Date.now();
    if (lastDecode.current.id === id && now - lastDecode.current.at < 1500) return;
    lastDecode.current = { id, at: now };

    looking.current = true;
    try {
      const dup = itemsRef.current.find((i) => i.itemId === id);
      if (dup) return say("err", `Already added — ${dup.make} ${dup.model} · SN ${dup.serialNumber}`);

      const res = await lookupScannedItem(id);
      if (!res.ok) {
        const msg: Record<typeof res.code, string> = {
          NOT_FOUND: "That item no longer exists",
          RETIRED: "That item is retired and can't be transferred",
          UNAUTHORIZED: "Your session expired — sign in again",
          FAILED: "Couldn't look up that item — try again",
        };
        return say("err", msg[res.code]);
      }

      const newItem: BuilderItem = {
        itemId: res.item.id, make: res.item.make, model: res.item.model,
        serialNumber: res.item.serialNumber, holderName: res.holderName,
      };
      // Built from the LIVE list (itemsRef), not a captured snapshot.
      const next = [...itemsRef.current, newItem];
      // The server gate on load swaps the whole form for a card
      // (receipts/new/page.tsx:52-55). Doing that here would destroy a
      // half-filled form, so the SCAN is refused and the form left untouched.
      // createTransfer remains the authority.
      const nextLines = groupItemsIntoLines(next);
      if (nextLines.length > MAX_RECEIPT_ROWS) return say("err", `This receipt is full — ${MAX_RECEIPT_ROWS} item types max`);
      if (nextLines.some((l) => l.serials.length > MAX_ITEMS_PER_ROW)) {
        return say("err", `Too many of one item — ${MAX_ITEMS_PER_ROW} per make and model max`);
      }

      itemsRef.current = next; // eager, so a scan landing before re-render sees it
      setItems(next);
      // Spec: the mixed-holder warning does double duty — a toast at scan time
      // AND a persistent row marker (added below). This is the toast half.
      say("ok", `Added: ${newItem.make} ${newItem.model} · SN ${newItem.serialNumber}${holderNote(newItem.holderName)}`);
    } finally {
      looking.current = false;
    }
  };

  // Keyed by line (make+model), matching how groupItemsIntoLines groups. An
  // ABSENT entry means "untouched" and renders the live item count; a present
  // one is the operator's explicit value and wins from then on. Storing only
  // overrides is what makes tracking-until-edited fall out for free.
  const [qtyEdits, setQtyEdits] = useState<Record<string, { auth?: string; issued?: string }>>({});
  const lineKey = (ln: { make: string; model: string }) => `${ln.make} ${ln.model}`;
  const qtyValue = (ln: { make: string; model: string; defaultQty: number }, field: "auth" | "issued") =>
    qtyEdits[lineKey(ln)]?.[field] ?? String(ln.defaultQty);
  const setQty = (ln: { make: string; model: string }, field: "auth" | "issued", v: string) =>
    setQtyEdits((prev) => ({ ...prev, [lineKey(ln)]: { ...prev[lineKey(ln)], [field]: v } }));

  // Optional return timer, in days from when the receipt is filed. Blank = no
  // timer. Posted as `returnDays`, parsed by receiptSchema.
  const [returnDays, setReturnDays] = useState("");

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

  // A signature attests to a SPECIFIC item list. If the list changes, the ink no
  // longer covers what will be filed, so it is discarded and the operator is
  // told why (silently clearing it would read as a glitch and get re-signed
  // without anyone understanding what changed).
  //
  // The key remount is what actually clears the pad: SignaturePad owns its
  // canvas and its hidden input, so re-mounting is the only way to blank both.
  // Applies to a picked saved technician signature too — a DCSIM recipient's
  // saved ink is still their attestation to a list, so pickedId is dropped as
  // well (TechnicianSignatureField never reports null on the way out; see the
  // comment on onReceiverDcsimChange above).
  const itemsKey = items.map((i) => i.itemId).join(",");
  const [hasSignature, setHasSignature] = useState(false);
  const [sigCleared, setSigCleared] = useState(false);

  // A guarded render-time write, compared on the KEY and only written when it
  // changes — the "Storing information from previous renders" pattern, matching
  // ItemDetailsCard.tsx:43-47. Not an effect: an effect would clear the ink one
  // paint AFTER the new row is on screen, leaving a frame where the signature
  // and the changed list are both live.
  const [prevItemsKey, setPrevItemsKey] = useState(itemsKey);
  if (itemsKey !== prevItemsKey) {
    setPrevItemsKey(itemsKey);
    if (hasSignature || pickedId !== null) setSigCleared(true);
    setHasSignature(false);
    setPickedId(null);
  }

  const onSignatureChange = (dataUrl: string) => {
    setHasSignature(!!dataUrl);
    if (dataUrl) setSigCleared(false);
  };

  // Warns only when a sender name is present AND differs: an item never
  // transferred has no holder to disagree with, and a blank sender cannot
  // conflict with anything. Added, never blocked — see the spec.
  const holderOf = new Map(items.map((i) => [i.itemId, i.holderName]));
  const holderWarning = (itemId: string) => {
    const holder = holderOf.get(itemId);
    if (!holder || !senderName || holder === senderName) return null;
    return `Held by ${holder}, not ${senderName}`;
  };

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
      {items.map((it) => <input key={it.itemId} type="hidden" name="itemId" value={it.itemId} />)}
      <fieldset className="card stack-sm">
        <legend className="card__title">Items ({lines.length} {lines.length === 1 ? "row" : "rows"})</legend>
        {/* "Scan to add", not "Scan": the phone's own camera app also scans these
            stickers, but it can only OPEN the item page — it cannot feed a form
            that is already open. Naming the action keeps the two apart. */}
        <button type="button" className="btn btn-secondary scan-add" onClick={() => setScanning(true)}>Scan to add</button>
        {/* Shown here only once the sheet is CLOSED. While scanning, the sheet
            itself shows this same toast via `notice` (passed to QrScanner
            below) — rendering it here too would put two elements on screen
            carrying the same text (and, for the mixed-holder "ok" case, the
            same text a persisted row marker also carries). Gating on
            `!scanning` keeps exactly one of them mounted at a time. */}
        {toast && !scanning && (
          <p role="status" aria-live="polite" className={toast.kind === "ok" ? "alert-success" : "alert-error"}>{toast.text}</p>
        )}
        <div className="table-wrap">
          <table className="table">
            {/* The "Service" column (per-item "Needs service?") is only offered
                when the RECIPIENT is DCSIM — the queue is for kit coming in to
                the desk, not equipment issued to an outside customer. Header and
                cells share the same `receiverIsDcsim` gate so the column appears
                and disappears as one unit; createReceiptAction drops any service
                selections for a non-DCSIM recipient too, so this isn't UI-only. */}
            <thead><tr><th>#</th><th>Item</th><th>Serial</th>{receiverIsDcsim && <th>Service</th>}<th>Auth</th><th>Issued</th><th></th></tr></thead>
            <tbody>
              {lines.map((ln, i) => (
                <Fragment key={`${ln.make} ${ln.model}`}>
                  {ln.itemIds.map((itemId, k) => (
                    <tr key={itemId}>
                      {k === 0 ? (
                        <>
                          <td data-label="Line">{i + 1}</td>
                          <td data-label="Item">{ln.make} {ln.model}
                            <input type="hidden" name={`line[${i}][make]`} value={ln.make} />
                            <input type="hidden" name={`line[${i}][model]`} value={ln.model} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="is-empty"></td>
                          <td className="is-empty"></td>
                        </>
                      )}
                      {/* The warning lives with the SERIAL, which is what the mobile
                          card leads with (globals.css:980-988) and what an operator
                          matches against the sticker. `.is-stacked` only when it is
                          present — a restacked cell is a flex row, so two children
                          would otherwise sit side by side and collide. */}
                      <td className={holderWarning(itemId) ? "mono is-stacked" : "mono"} data-label="Serial">
                        {ln.serials[k]}
                        {holderWarning(itemId) && <span className="subtle">{holderWarning(itemId)}</span>}
                      </td>
                      {receiverIsDcsim && <td className="is-stacked" data-label="Service"><ServiceControls itemId={itemId} /></td>}
                      {k === 0 && (
                        <>
                          {/* rowSpan stays. The quantities are per LINE, not per serial —
                              one pair of inputs covers every serial of this make/model.
                              Splitting them per row would emit duplicate
                              `line[i][qtyAuth]` fields and change what the form submits. */}
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty authorized (all ${ln.itemIds.length} serials)` : "Qty authorized"}>
                            <QtyInput name={`line[${i}][qtyAuth]`} value={qtyValue(ln, "auth")} onChange={(v) => setQty(ln, "auth", v)} label={`Quantity authorized, ${ln.make} ${ln.model}`} />
                          </td>
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty issued (all ${ln.itemIds.length} serials)` : "Qty issued"}>
                            <QtyInput name={`line[${i}][qtyIssued]`} value={qtyValue(ln, "issued")} onChange={(v) => setQty(ln, "issued", v)} label={`Quantity issued, ${ln.make} ${ln.model}`} />
                          </td>
                        </>
                      )}
                      {/* `.actions--end`, never an inline justifyContent — an inline style
                          outranks the mobile rule that re-aligns actions inside a stacked
                          card, which is the bug a08d9e5 fixed in three places. */}
                      <td className="actions actions--end" data-label="">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeItem(itemId)}
                          disabled={items.length === 1}
                          aria-label={`Remove ${ln.make} ${ln.model}, serial ${ln.serials[k]}`}
                        >
                          Remove
                        </button>
                      </td>
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
      <PartyFields role="sender" prefill={senderPrefill} isDcsim={senderIsDcsim} onIsDcsimChange={setSenderIsDcsim} name={senderName} onNameChange={setSenderName} />
      <PartyFields role="receiver" isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} name={receiverName} onNameChange={setReceiverName} />
      {/* Return timer (optional): blank = no timer. Presets set the days field. */}
      <fieldset className="card stack-sm">
        <legend className="card__title">Return by (optional)</legend>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReturnDays(String(d))}
            >
              {d}d
            </button>
          ))}
          <input
            className="input"
            style={{ width: "auto", minWidth: 140 }}
            name="returnDays"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="custom days"
            aria-label="Return by, days from now"
            value={returnDays}
            onChange={(e) => setReturnDays(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </div>
        <span className="subtle" style={{ fontSize: 12 }}>Leave blank for no return timer.</span>
      </fieldset>
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature{receiverIsDcsim ? " (DCSIM)" : ""}</legend>
        {sigCleared && (
          <p role="alert" className="alert-error">Items changed — please sign again.</p>
        )}
        {receiverIsDcsim ? (
          // A DCSIM recipient is our own technician at the desk, so they may pick
          // their saved signature. An outside recipient must always draw in person.
          // onChange IS wired here, not only onPickedChange: without it a DCSIM
          // recipient's DRAWN ink (the common case — signatures=[] for non-admins,
          // so this field is always in draw state for them) is wiped by the remount
          // with no "please sign again" notice. onChange fires for both a draw and
          // a pick (TechnicianSignatureField.tsx:47,50), so it feeds hasSignature
          // and resets sigCleared on a re-pick.
          <TechnicianSignatureField
            key={itemsKey}
            name="receiverSignature"
            signatures={signatures}
            label="Who received it?"
            drawHint={null}
            onChange={onSignatureChange}
            onPickedChange={setPickedId}
          />
        ) : (
          <SignaturePad key={itemsKey} name="receiverSignature" onChange={onSignatureChange} />
        )}
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Creating…" : "Create hand receipt"}</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
      {scanning && <QrScanner onDecode={onDecode} onClose={() => setScanning(false)} notice={toast} />}
    </form>
  );
}
