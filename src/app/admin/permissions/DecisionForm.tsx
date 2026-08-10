"use client";
import { useActionState, useState } from "react";
import type { Capability } from "@prisma/client";
import { decidePermissionRequestAction } from "@/app/actions/permissions";
import { CAPABILITY_LABELS, isElevated } from "@/modules/users/capabilities";

/**
 * Decide one request by UNCHECKING what you are not granting.
 *
 * Everything starts checked EXCEPT elevated capabilities, which start
 * unchecked: granting full administrative control should take a deliberate
 * tick, not a deliberate untick. Anything left unchecked is recorded as denied,
 * which is why the reason field appears the moment a box is cleared — a denial
 * the requester cannot act on is a dead end.
 *
 * `selfRequest` disables the whole form: an admin may never decide their own
 * request. The server enforces it regardless; this exists so the refusal is
 * visible before submitting rather than after.
 */
export function DecisionForm({
  requestId,
  capabilities,
  selfRequest,
}: {
  requestId: string;
  capabilities: Capability[];
  selfRequest: boolean;
}) {
  const [state, action, pending] = useActionState(decidePermissionRequestAction, undefined);
  const [checked, setChecked] = useState<Set<Capability>>(
    () => new Set(capabilities.filter((c) => !isElevated(c))),
  );

  const approving = checked.size;
  const total = capabilities.length;
  const anyDenied = approving < total;

  const toggle = (c: Capability) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  if (selfRequest) {
    return (
      <p className="alert-warning" role="note">
        This is your own request. Another administrator has to decide it — approving your own
        request would be a self-grant.
      </p>
    );
  }

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Grant these</legend>
        {capabilities.map((c) => {
          const elevated = isElevated(c);
          return (
            <label
              key={c}
              className={`capability-option${elevated ? " capability-option--elevated" : ""}`}
            >
              <input
                type="checkbox"
                name="approve"
                value={c}
                checked={checked.has(c)}
                onChange={() => toggle(c)}
              />
              <span>
                <span className="capability-option__name">{CAPABILITY_LABELS[c]}</span>
                {elevated && (
                  <span className="capability-option__hint">
                    Ticking this makes them an administrator — it changes their role, not just
                    one permission, so they get everything on this list. Unchecked by default;
                    tick it deliberately.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* Appears the moment anything is unchecked, because unchecking IS
          denying and a denial with no reason is a dead end for the requester. */}
      {anyDenied && (
        <div className="field">
          <label className="label" htmlFor={`reason-${requestId}`}>
            Why are you not granting the rest?
          </label>
          <textarea
            id={`reason-${requestId}`}
            className="textarea"
            name="denialReason"
            required
            rows={2}
            placeholder="e.g. Returns stay with the two senior technicians. Ask again after handover."
          />
          <p className="subtle" style={{ fontSize: 13, marginTop: 6 }}>
            The requester sees this.
          </p>
        </div>
      )}

      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}

      <div className="row">
        {/* Reactive so the admin cannot misread what they are about to do. */}
        <button
          disabled={pending}
          type="submit"
          className={`btn ${approving === 0 ? "btn-danger" : "btn-primary"}`}
        >
          {pending
            ? "Saving…"
            : approving === 0
              ? "Deny all"
              : `Approve ${approving} of ${total}`}
        </button>
      </div>
    </form>
  );
}
