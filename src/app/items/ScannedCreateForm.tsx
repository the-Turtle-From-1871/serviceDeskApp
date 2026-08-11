"use client";
import { useState } from "react";
import { createScannedItemsAction } from "@/app/admin/actions/scanned-items";
import type { SelectedItem } from "@/components/items-view";
import type { NewEntry } from "./scan-session";

type Draft = { make: string; model: string };

/**
 * Create the serials a scan session found no item for.
 *
 * The serial is FIXED — it came off the label, and letting it be edited here
 * would quietly decouple what was scanned from what is written. Make and model
 * are prefilled from the label where the QR carried a description.
 */
export function ScannedCreateForm({
  entries, onCancel, onCreated,
}: {
  entries: NewEntry[];
  onCancel: () => void;
  onCreated: (items: SelectedItem[], created: number, existed: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(entries.map((e) => [e.serial, { make: e.label?.make ?? "", model: e.label?.model ?? "" }])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (serial: string, field: keyof Draft, value: string) =>
    setDrafts((d) => ({ ...d, [serial]: { ...d[serial], [field]: value } }));

  const submit = async () => {
    const rows = entries.map((e) => ({
      serialNumber: e.serial,
      make: drafts[e.serial].make.trim(),
      model: drafts[e.serial].model.trim(),
    }));
    const missing = rows.find((r) => !r.make || !r.model);
    if (missing) return setError(`${missing.serialNumber} needs a make and a model.`);

    setError(null);
    setBusy(true);
    const res = await createScannedItemsAction(rows);
    setBusy(false);
    if ("error" in res) return setError(res.error);
    onCreated(res.items, res.created, res.existed);
  };

  return (
    <div className="scan-create stack-sm">
      <p className="subtle">
        {entries.length} scanned serial{entries.length === 1 ? "" : "s"} {entries.length === 1 ? "is" : "are"} not
        in the book. These are created without a device name, so they will have no home unit until one is
        added.
      </p>
      {entries.map((e) => (
        <div key={e.serial} className="scan-create__row">
          <strong>{e.serial}</strong>
          <label className="sr-only" htmlFor={`make-${e.serial}`}>Make for {e.serial}</label>
          <input
            id={`make-${e.serial}`} className="input" placeholder="Make"
            value={drafts[e.serial].make} onChange={(ev) => set(e.serial, "make", ev.target.value)}
          />
          <label className="sr-only" htmlFor={`model-${e.serial}`}>Model for {e.serial}</label>
          <input
            id={`model-${e.serial}`} className="input" placeholder="Model"
            value={drafts[e.serial].model} onChange={(ev) => set(e.serial, "model", ev.target.value)}
          />
        </div>
      ))}
      {error && <p role="alert" className="alert-error">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? "Creating…" : `Create ${entries.length}`}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Skip the rest</button>
      </div>
    </div>
  );
}
