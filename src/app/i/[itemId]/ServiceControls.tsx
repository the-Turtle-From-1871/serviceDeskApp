"use client";
import { useActionState, useState } from "react";
import {
  setServiceAction,
  setServiceDeadlineAction,
  clearServiceAction,
  completeServiceAction,
  reopenServiceAction,
} from "@/app/admin/actions/queue";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Props = {
  itemId: string;
  request: {
    id: string;
    serviceType: "REIMAGE" | "REPAIR" | "OTHER";
    serviceNote: string | null;
    status: "PENDING" | "COMPLETED";
    // Server-formatted so this client component never parses or formats a date
    // (no locale/timezone hydration mismatch, no clock read during render).
    dueAtLabel: string | null;
  } | null;
};

// Admin-only controls on the item detail Service card: flag/update the request,
// set or clear its deadline, and mark completed / reopen. Kept separate from the
// read-only card so non-admins never load it.
//
// THE DEADLINE HAS ITS OWN FORM, and that split is load-bearing rather than
// cosmetic. The stored value is an absolute instant while the input is *days
// from now*, so there is no way to prefill this field such that re-submitting it
// unchanged reproduces the stored deadline — "4 days remaining" saved back means
// "due 4 days from now", which walks the deadline forward on every save. So the
// flag form (type + note) simply stops carrying a deadline once a request
// exists: it sends nothing about dueAt, and the server writes nothing, so the
// stored instant is untouched no matter how often the note is edited. The days
// field remains on the flag form only while CREATING a flag, where blank
// genuinely means "no deadline" because there is nothing to preserve.
//
// This mirrors the hand-receipt return timer, which solved the same problem the
// same way: ReceiptDueAtControls is a standalone form whose blank clears, and
// closing/returning/notifying a receipt never touches Transfer.dueAt.
export function ServiceControls({ itemId, request }: Props) {
  const [state, action, pending] = useActionState(setServiceAction, undefined);
  const [deadlineState, dueAction, duePending] = useActionState(setServiceDeadlineAction, undefined);
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
          {/* Creation only — see the note above. Once a request exists this field
              is gone and the deadline is edited below, so "Update service" can
              never be a silent decision about a deadline. */}
          {!request && (
            <label className="stack" style={{ gap: 4 }}>
              <span className="subtle" style={{ fontSize: 12 }}>Deadline (days)</span>
              <input
                className="input"
                style={{ width: "auto", minWidth: 140 }}
                name="overrideDays"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Blank = no deadline"
                title="Optional whole number 1–3650 of days from now. Leave blank for no completion deadline."
              />
            </label>
          )}
          <button className="btn btn-primary" disabled={pending} type="submit">
            {pending ? "Saving…" : request ? "Update service" : "Flag for service"}
          </button>
        </div>
        {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
        {state?.ok && <p className="alert-success">Saved.</p>}
      </form>

      {/* PENDING only: a deadline on completed work has nothing to measure, and
          a completed row's next deadline is chosen on the Reopen form instead. */}
      {request?.status === "PENDING" && (
        <form action={dueAction} className="stack-sm">
          <input type="hidden" name="itemId" value={itemId} />
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="stack" style={{ gap: 4 }}>
              <span className="subtle" style={{ fontSize: 12 }}>
                Deadline — currently {request.dueAtLabel ?? "none"}
              </span>
              <input
                className="input"
                style={{ width: "auto", minWidth: 180 }}
                name="overrideDays"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="days (blank clears)"
                aria-label="Service deadline in days from now (blank clears it)"
                title="Whole number 1–3650 of days from now. Leave blank and save to remove the deadline."
              />
            </label>
            <button className="btn btn-secondary" disabled={duePending} type="submit">
              {duePending ? "Saving…" : "Update deadline"}
            </button>
          </div>
          {deadlineState?.error && <p role="alert" className="alert-error">{deadlineState.error}</p>}
          {deadlineState?.ok && <p className="alert-success">Deadline saved.</p>}
        </form>
      )}

      {request && (
        <div className="row" style={{ gap: 6 }}>
          {request.status === "PENDING" ? (
            <form action={completeServiceAction}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <button type="submit" className="btn btn-secondary btn-sm">Mark Completed</button>
            </form>
          ) : (
            <form action={reopenServiceAction} className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <input
                className="input"
                style={{ width: "auto", minWidth: 180 }}
                name="overrideDays"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="days (blank = no deadline)"
                aria-label="Deadline in days for the reopened round (blank for no deadline)"
                title="Optional whole number 1–3650 of days from now. Reopening starts a NEW round of service, so it does not carry the finished round's deadline over — leave blank for no deadline, or set one here."
              />
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
