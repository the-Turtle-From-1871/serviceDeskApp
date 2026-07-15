"use client";
import { useActionState, useEffect, useState } from "react";
import { createContactAction, updateContactAction, deleteContactAction } from "@/app/admin/actions/contacts";
import { RANK_OPTIONS } from "@/lib/ranks";
import { PhoneInput } from "@/components/PhoneInput";
import type { ContactOption } from "@/modules/contacts/contact-match";

// The add and edit forms take the same fields; `contact` seeds the edit case.
// `idPrefix` keeps label/input ids unique when an edit row renders alongside the
// add form.
function ContactFields({ idPrefix, contact }: { idPrefix: string; contact?: ContactOption }) {
  return (
    <div className="form-grid">
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-rank`}>Rank</label>
        <input
          id={`${idPrefix}-rank`} className="input" name="rank" list={`${idPrefix}-ranks`}
          defaultValue={contact?.rank ?? ""} placeholder="e.g. SGT (optional)" autoComplete="off"
        />
        <datalist id={`${idPrefix}-ranks`}>
          {RANK_OPTIONS.map((r) => <option key={r} value={r} />)}
        </datalist>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-first`}>First name</label>
        <input id={`${idPrefix}-first`} className="input" name="firstName" defaultValue={contact?.firstName ?? ""} placeholder="Jane" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-last`}>Last name</label>
        <input id={`${idPrefix}-last`} className="input" name="lastName" defaultValue={contact?.lastName ?? ""} placeholder="Doe" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-email`}>Email</label>
        <input id={`${idPrefix}-email`} className="input" name="email" type="email" defaultValue={contact?.email ?? ""} placeholder="jane@unit.mil" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-unit`}>Unit</label>
        <input id={`${idPrefix}-unit`} className="input" name="unit" defaultValue={contact?.unit ?? ""} placeholder="e.g. A Co, 1-1 IN (optional)" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-contact`}>Contact number</label>
        <PhoneInput id={`${idPrefix}-contact`} name="contactNumber" defaultValue={contact?.contactNumber ?? undefined} />
      </div>
    </div>
  );
}

function NewContactForm() {
  const [state, action, pending] = useActionState(createContactAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <ContactFields idPrefix="nc" />
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Adding…" : "Add contact"}
        </button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
        {state && "ok" in state && state.ok && <span className="alert-success">Contact saved.</span>}
      </div>
    </form>
  );
}

function EditContactForm({ contact, onDone }: { contact: ContactOption; onDone: () => void }) {
  const [state, action, pending] = useActionState(updateContactAction, undefined);
  // Close the row once the server confirms the write. This MUST be an effect,
  // not a bare `if (ok) onDone()` in the render body — that would set the parent's
  // state while rendering a child, which React rejects.
  const ok = state !== undefined && "ok" in state && state.ok;
  useEffect(() => {
    if (ok) onDone();
  }, [ok, onDone]);
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="id" value={contact.id} />
      <ContactFields idPrefix={`ec-${contact.id}`} contact={contact} />
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary btn-sm">
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}

export function ContactBookSection({ contacts }: { contacts: ContactOption[] }) {
  // One row editable at a time — an inline form per row would multiply
  // useActionState instances for no benefit.
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="card">
        <div className="card__title">Add a contact</div>
        <p className="subtle">
          Saved recipients are shared with everyone and autofill the recipient
          fields on a new hand receipt.
        </p>
        <NewContactForm />
      </div>

      {contacts.length === 0 ? (
        <div className="card empty">No saved contacts yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Unit</th>
                <th>Contact number</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) =>
                editingId === c.id ? (
                  <tr key={c.id}>
                    <td colSpan={5} data-label="">
                      <EditContactForm contact={c} onDone={() => setEditingId(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id}>
                    <td data-label="Name">
                      {c.rank ? `${c.rank} ` : ""}
                      <strong>{c.lastName}, {c.firstName}</strong>
                    </td>
                    <td className="mono" data-label="Email">{c.email}</td>
                    <td data-label="Unit">{c.unit ?? <span className="subtle">—</span>}</td>
                    <td data-label="Contact number">{c.contactNumber ?? <span className="subtle">—</span>}</td>
                    <td data-label="">
                      <div className="actions" style={{ justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(c.id)}>
                          Edit
                        </button>
                        <form action={deleteContactAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" className="btn btn-danger btn-sm">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
