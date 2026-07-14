"use client";
import { useActionState, useState } from "react";
import { setServiceAction, clearServiceAction, completeServiceAction, reopenServiceAction } from "@/app/admin/actions/queue";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Props = {
  itemId: string;
  request: { id: string; serviceType: "REIMAGE" | "REPAIR" | "OTHER"; serviceNote: string | null; status: "PENDING" | "COMPLETED" } | null;
};

// Admin-only controls on the item detail Service card: flag/update the request,
// clear it, and mark completed / reopen. Kept separate from the read-only card so
// non-admins never load it.
export function ServiceControls({ itemId, request }: Props) {
  const [state, action, pending] = useActionState(setServiceAction, undefined);
  const [type, setType] = useState<string>(request?.serviceType ?? "REIMAGE");

  return (
    <div className="stack-sm">
      <form action={action} className="stack-sm">
        <input type="hidden" name="itemId" value={itemId} />
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="subtle" style={{ fontSize: 12 }}>Service type</span>
            <select className="select" style={{ width: "auto", minWidth: 130 }} name="serviceType" value={type} onChange={(e) => setType(e.target.value)}>
              {SERVICE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {type === "OTHER" && (
            <input className="input" style={{ minWidth: 200 }} name="note" placeholder="Describe the service needed" aria-label="Describe the service needed" defaultValue={request?.serviceNote ?? ""} required />
          )}
          <button className="btn btn-primary" disabled={pending} type="submit">
            {pending ? "Saving…" : request ? "Update service" : "Flag for service"}
          </button>
        </div>
        {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
        {state?.ok && <p className="alert-success">Saved.</p>}
      </form>

      {request && (
        <div className="row" style={{ gap: 6 }}>
          {request.status === "PENDING" ? (
            <form action={completeServiceAction}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <button type="submit" className="btn btn-secondary btn-sm">Mark Completed</button>
            </form>
          ) : (
            <form action={reopenServiceAction}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <button type="submit" className="btn btn-secondary btn-sm">Reopen</button>
            </form>
          )}
          <form action={clearServiceAction}>
            <input type="hidden" name="itemId" value={itemId} />
            <button type="submit" className="btn btn-ghost btn-sm">Remove service flag</button>
          </form>
        </div>
      )}
    </div>
  );
}
