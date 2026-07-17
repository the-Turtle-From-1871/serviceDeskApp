"use client";
import { useActionState } from "react";
import { markAuditedAction } from "@/app/admin/actions/audit";
import type { PickableSignature } from "@/components/TechnicianSignatureField";

// Admin-only control on the item detail Audit card: pick a saved signature and mark
// the item audited. Posts only `signatureId` — the server re-reads the signer name
// and image scoped to the acting admin.
export function AuditControls({ itemId, signatures }: { itemId: string; signatures: PickableSignature[] }) {
  const [state, action, pending] = useActionState(markAuditedAction, undefined);

  if (signatures.length === 0) {
    return (
      <p className="subtle">
        Add a signature in your <a href="/account">account settings</a> to mark items as audited.
      </p>
    );
  }

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Signature</span>
          <select className="select" style={{ width: "auto", minWidth: 180 }} name="signatureId" defaultValue="" required>
            <option value="" disabled>— Select who audited —</option>
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={pending} type="submit">
          {pending ? "Saving…" : "Mark as audited"}
        </button>
      </div>
      {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
      {state?.ok && <p className="alert-success">Marked as audited.</p>}
    </form>
  );
}
