"use client";
import { useRef, useState } from "react";
import { deleteItemAction } from "@/app/admin/actions/items";

/**
 * Permanent delete, behind an explicit confirmation.
 *
 * A native <dialog>, not a shadcn Dialog: there is no Dialog primitive in this
 * repo, /items is on the original globals.css system that CLAUDE.md says not to
 * rewrite as a drive-by, and because Tailwind preflight is deliberately not
 * imported a new shadcn primitive has to re-supply border-solid, appearance-none
 * and the 44px tap floor by hand. <dialog> avoids that whole class of bug and
 * gives us Escape-to-close for free.
 */
export function DeleteItemButton({
  id, make, model, serialNumber, holderName, onOpen,
}: {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
  /** The recipient named on this item's current OPEN hand receipt, if any —
   *  same value ItemSelectTable already carries per row (items-view.ts's
   *  ItemRow.holderName, derived server-side for the whole page). Never
   *  fetched here: a per-row query on a delete button would be the exact N+1
   *  CLAUDE.md's data-fetching rule forbids. Null/undefined renders no
   *  warning — the item isn't currently signed out. */
  holderName?: string | null;
  /** Fired just before the dialog opens. /items uses it to retract the mobile
   *  swipe drawer this button was tapped in, so no ancestor is mid-transform
   *  while a modal is in the top layer. */
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => { onOpen?.(); ref.current?.showModal(); }}>
        Delete
      </button>
      {/* No className on the <dialog> itself. The UA stylesheet hides a closed
          dialog with `dialog:not([open]) { display: none; }`, which is a
          low-specificity type-selector rule — any AUTHOR class selector
          (.card sets display: block, .stack sets display: flex) outranks it
          regardless of open/closed state, so a closed dialog carrying either
          class renders anyway. One per row × every row on /items = a page
          full of invisible-looking but very present 375x375 boxes stacked
          down the DOM, intercepting clicks meant for the buttons under them.
          The card/stack styling instead lives on an inner wrapper div, which
          the UA rule has no reason to fight: the dialog itself carries only
          the inline styles needed to undo ITS OWN UA box (default border/
          padding/background) and to cap the wrapper's width.

          onClose fires for EVERY way a <dialog> stops being open — the
          Cancel button's ref.current?.close(), Escape (which the UA turns
          into a "cancel" then a "close"), and the success path's own
          ref.current?.close() below — so clearing the error here is the one
          place that covers all three, instead of duplicating the reset on
          each dismissal path. A stale failure message from a previous
          attempt must not still be showing the next time this dialog opens. */}
      <dialog
        ref={ref}
        onClose={() => setError(null)}
        style={{ padding: 0, border: "none", background: "transparent", maxWidth: "32rem" }}
      >
        <div className="card stack">
          <div className="card__title">Delete this item permanently?</div>
          <p>
            <strong>{make} {model}</strong> · {serialNumber}
          </p>
          {holderName && (
            <p className="alert-warning">
              <strong>This item is currently signed out to {holderName}.</strong>{" "}
              Its hand receipt will keep this record, but the item will disappear
              from inventory — deleting it does not require or record a return.
            </p>
          )}
          <p>
            This cannot be undone. The item is removed from inventory along with its
            audit and edit history. To take a device out of service without erasing
            it, use <strong>Retire</strong> instead.
          </p>
          {/* Says so explicitly, because a careful admin will otherwise assume the
              opposite and never use this control. */}
          <p className="subtle">
            Hand receipts are not affected — every receipt keeps the serial number,
            make, model and signatures it was issued with.
          </p>
          {error && <p role="alert" className="alert-error">{error}</p>}
          <div className="row">
            <form
              action={async (fd) => {
                setPending(true);
                setError(null);
                try {
                  const res = await deleteItemAction(fd);
                  if (res?.error) setError(res.error);
                  else ref.current?.close();
                } catch {
                  // requireAdmin() throws when the caller lost admin between page
                  // load and this click (demoted/deactivated in another tab or by
                  // another admin — both take effect on the next request, by
                  // design). Without this catch the throw rejects this handler's
                  // promise before setPending(false) runs, so the button would be
                  // stuck on "Deleting…" forever with no explanation. Never
                  // surface the raw error (CLAUDE.md §5) — just let them retry.
                  setError("Something went wrong. Please refresh the page and try again.");
                } finally {
                  setPending(false);
                }
              }}
            >
              <input type="hidden" name="id" value={id} />
              <button type="submit" disabled={pending} className="btn btn-danger">
                {pending ? "Deleting…" : "Delete permanently"}
              </button>
            </form>
            <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
