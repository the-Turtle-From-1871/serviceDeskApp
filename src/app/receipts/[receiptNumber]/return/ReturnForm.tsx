"use client";
import { useActionState, useMemo, useState } from "react";
import { processReturnAction } from "@/app/actions/returns";
import type { HeldItem } from "@/modules/returns/plan";
import { TechnicianSignatureField } from "@/components/TechnicianSignatureField";

const VERIFY_LABEL = "I have physically verified that the serial number on the device matches the screen";

export function ReturnForm({ receiptNumber, held, savedSignature }: { receiptNumber: string; held: HeldItem[]; savedSignature?: string | null }) {
  const [state, action, pending] = useActionState(processReturnAction, undefined);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [verified, setVerified] = useState(false);
  const [signature, setSignature] = useState(savedSignature ?? "");

  const lines = useMemo(() => {
    const by = new Map<number, { lineNo: number; make: string; model: string; items: HeldItem[] }>();
    for (const h of held) {
      let g = by.get(h.lineNo);
      if (!g) { g = { lineNo: h.lineNo, make: h.make, model: h.model, items: [] }; by.set(h.lineNo, g); }
      g.items.push(h);
    }
    return [...by.values()].sort((a, b) => a.lineNo - b.lineNo);
  }, [held]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function returnAll() { setChecked(new Set(held.map((h) => h.transferItemId))); }

  if (state && "ok" in state) {
    return (
      <div className="card stack-sm">
        <h2 className="card__title">{state.closed ? "Receipt cleared and closed" : "Partial return processed"}</h2>
        <ul>
          {state.plan.byLine.filter((l) => l.returnedNow > 0).map((l) => (
            <li key={l.lineNo}>
              {l.make} {l.model}: <s className="subtle">{l.heldBefore}</s>{" "}
              <strong>{l.heldAfter}</strong> remaining
            </li>
          ))}
        </ul>
        <p className="subtle">A confirmation email has been sent to the customer{state.closed ? " with the clearance record" : ""}.</p>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${state.receiptNumber}`}>View receipt</a>
          <a className="btn btn-ghost" href="/items">Back to items</a>
        </div>
      </div>
    );
  }

  const canSubmit = checked.size > 0 && verified && signature.length > 0 && !pending;

  return (
    <form action={action} className="stack">
      <input type="hidden" name="receiptNumber" value={receiptNumber} />
      {lines.map((ln) => (
        <fieldset key={ln.lineNo} className="card stack-sm">
          <legend className="card__title">{ln.make} {ln.model}</legend>
          {ln.items.map((it) => (
            <label key={it.transferItemId} className="row">
              <input type="checkbox" name="itemId" value={it.transferItemId} checked={checked.has(it.transferItemId)} onChange={() => toggle(it.transferItemId)} />
              <span className="mono">{it.serialNumber}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={returnAll}>Return all remaining</button>
      </div>
      <label className="row">
        <input type="checkbox" name="verified" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
        {VERIFY_LABEL}
      </label>
      <fieldset className="card stack-sm">
        <legend className="card__title">Technician signature</legend>
        <p className="subtle">Sign to confirm you accepted these items.</p>
        <TechnicianSignatureField name="signature" saveOptName="saveSignature" savedSignature={savedSignature} onChange={setSignature} />
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={!canSubmit} type="submit">
          {pending ? "Processing…" : "Process return"}
        </button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
