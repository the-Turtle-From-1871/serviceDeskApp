"use client";
import { useActionState } from "react";
import type { Capability } from "@prisma/client";
import { requestPermissionsAction } from "@/app/actions/permissions";
import { CAPABILITY_LABELS, isElevated } from "@/modules/users/capabilities";

/**
 * The request form. `available` is everything the user does not already hold
 * and may request — computed on the server, so the list cannot offer something
 * the service would refuse.
 *
 * An elevated capability gets the danger treatment and says what it means, but
 * is NOT hidden or disabled: it is requestable by design, and an administrator
 * decides.
 */
export function RequestPermissionsForm({ available }: { available: Capability[] }) {
  const [state, action, pending] = useActionState(requestPermissionsAction, undefined);
  const sent = !!(state && "ok" in state && state.ok);

  if (available.length === 0) {
    return <p className="subtle">You already have every permission this app offers.</p>;
  }

  if (sent) {
    return (
      <p className="alert-success" role="status">
        Request sent. An administrator will review it, and you&rsquo;ll get an email with the
        outcome.
      </p>
    );
  }

  return (
    <form action={action} className="stack-sm">
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">What do you need?</legend>
        {available.map((c) => {
          const elevated = isElevated(c);
          return (
            <label
              key={c}
              className={`capability-option${elevated ? " capability-option--elevated" : ""}`}
            >
              <input type="checkbox" name="capabilities" value={c} />
              <span>
                <span className="capability-option__name">{CAPABILITY_LABELS[c]}</span>
                {elevated && (
                  <span className="capability-option__hint">
                    Makes you an administrator. If this is approved your account becomes an
                    admin outright — every permission in this list, plus user management, the
                    access PIN and audits. Ask for it only if you are taking on administration
                    of the system.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="field">
        <label className="label" htmlFor="justification">
          Why do you need it? <span className="subtle">(optional)</span>
        </label>
        {/* No `required` and no `minLength`: any amount of text, including
            none. A browser-side floor here would refuse to submit the form at
            all, which is the failure this change exists to remove — and it
            would disagree with the schema, which now accepts "". */}
        <textarea
          id="justification"
          className="textarea"
          name="justification"
          rows={3}
          placeholder="e.g. I have taken over returns processing for the shop this quarter."
        />
        <p className="subtle" style={{ fontSize: 13, marginTop: 6 }}>
          This is the only thing the administrator sees when deciding, so a line of context
          helps — but leave it blank if you have already spoken to them.
        </p>
      </div>

      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Sending…" : "Request permissions"}
        </button>
      </div>
    </form>
  );
}
