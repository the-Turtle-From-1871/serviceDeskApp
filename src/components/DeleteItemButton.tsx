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
  id, make, model, serialNumber,
}: { id: string; make: string; model: string; serialNumber: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => ref.current?.showModal()}>
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
          padding/background) and to cap the wrapper's width. */}
      <dialog ref={ref} style={{ padding: 0, border: "none", background: "transparent", maxWidth: "32rem" }}>
        <div className="card stack">
          <div className="card__title">Delete this item permanently?</div>
          <p>
            <strong>{make} {model}</strong> · {serialNumber}
          </p>
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
                const res = await deleteItemAction(fd);
                setPending(false);
                if (res?.error) setError(res.error);
                else ref.current?.close();
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
