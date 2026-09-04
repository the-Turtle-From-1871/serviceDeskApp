"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DeleteItemButton } from "@/components/DeleteItemButton";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { useDismissSwallowsTap } from "@/components/SortFilterMenu";

/**
 * Right-click a row on /items to reach that row's actions without travelling to
 * the actions column at the far right.
 *
 * It ADDS a path; it replaces nothing. The row buttons stay exactly as they
 * were, and that is what makes this acceptable: a context menu is mouse-only,
 * so a menu that replaced them would leave keyboard users with no route to the
 * same actions.
 *
 * ONE MENU FOR THE WHOLE TABLE, not one per row. A page is 50 rows, and 50
 * popovers — each with its own delete <dialog> — is 50 elements in the DOM to
 * save one state variable. The targeted row's data is passed in instead.
 */

export type ContextTarget = {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
  holderName: string | null;
  status: "ACTIVE" | "RETIRED";
  /** Viewport coordinates of the click, so the menu opens under the cursor. */
  x: number;
  y: number;
};

/** Matches the 720px breakpoint globals.css uses to restack the table into
 *  cards. Below it the same <tr> is a swipeable card where a long-press already
 *  means something, and some mobile browsers raise `contextmenu` from a
 *  long-press — so the menu is desktop-only and the native one is left alone. */
export function isDesktopWidth(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 720px)").matches;
}

const MENU_ID = "item-row-context-menu";

export function ItemRowContextMenu({
  target,
  onClose,
  isAdmin,
}: {
  target: ContextTarget | null;
  onClose: () => void;
  isAdmin: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Set while the delete dialog is being opened FROM this menu.
  //
  // The dialog is rendered inside this component, so clearing `target` on the
  // way out unmounts it — and DeleteItemButton calls showModal() and onOpen()
  // in the same handler. React batches the state update, so the modal really
  // did open and was then thrown away by the re-render a tick later: the menu
  // vanished and nothing replaced it. Keeping `target` alive across that one
  // transition is what lets the dialog survive its own opening.
  // The row whose delete confirmation is open, held SEPARATELY from `target`
  // and rendered OUTSIDE the popover — see the DeleteItemButton at the bottom.
  const [deleteFor, setDeleteFor] = useState<ContextTarget | null>(null);
  // There is no trigger element — the trigger is a right-click anywhere on a
  // row — so the hook is given the menu's own id for both. Light dismiss still
  // delivers the click to whatever sat underneath, and on this table that is a
  // row that would toggle its own selection.
  useDismissSwallowsTap(MENU_ID, MENU_ID);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!target) {
      // `matches` rather than a flag: the browser may have closed it already
      // (Escape, light dismiss), and hidePopover on a closed popover throws.
      if (el.matches(":popover-open")) el.hidePopover();
      return;
    }
    if (!el.matches(":popover-open")) el.showPopover();
  }, [target]);

  // The browser fires `toggle` for every close, including Escape and light
  // dismiss, so this is the one place that covers all of them — the parent's
  // `target` must be cleared or a second right-click on the same row would set
  // identical state and the effect above would not re-open it.
  const onToggle = useCallback(
    (e: React.ToggleEvent<HTMLDivElement>) => {
      if (e.newState === "closed") onClose();
    },
    [onClose],
  );

  // Kept mounted even with no target: showPopover() needs the element to exist,
  // and mounting it on demand would race the effect that opens it.
  // NO className on the popover itself. The UA hides a closed one with
  // `[popover]:not(:popover-open) { display: none }`, a low-specificity type
  // rule that ANY author class setting `display` outranks — so a closed
  // popover carrying `.card` or `.stack` renders anyway and swallows clicks
  // meant for the table beneath it. Positioning is inline and sets no
  // `display`, so it cannot re-create that bug.
  return (
    <>
    <div
      ref={ref}
      id={MENU_ID}
      popover="auto"
      onToggle={onToggle}
      style={
        target
          ? { position: "fixed", top: `${target.y}px`, left: `${target.x}px`, margin: 0 }
          : undefined
      }
    >
      <div className="context-menu__panel">
        {target && (
          <>
            <div className="context-menu__heading">
              {target.make} {target.model} · {target.serialNumber}
            </div>
            <Link href={`/i/${target.id}`} className="btn btn-ghost btn-sm" onClick={onClose}>
              View
            </Link>
            {isAdmin && (
              <>
                <Link
                  href={`/admin/items/${target.id}/edit`}
                  className="btn btn-ghost btn-sm"
                  onClick={onClose}
                >
                  Edit
                </Link>
                <form action={toggleItemStatusAction} onSubmit={onClose}>
                  <input type="hidden" name="id" value={target.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={target.status === "RETIRED" ? "ACTIVE" : "RETIRED"}
                  />
                  <button type="submit" className="btn btn-ghost btn-sm">
                    {target.status === "RETIRED" ? "Reactivate" : "Retire"}
                  </button>
                </form>
                {/* A plain button, NOT DeleteItemButton: its <dialog> must not
                    live inside this popover. A closed popover is `display:
                    none`, which hides its whole subtree — so a modal opened
                    from in here is promoted to the top layer and then rendered
                    at 0x0 by a hidden ancestor. The DOM reports it open and
                    `:modal`; the screen shows nothing. Found in a browser, not
                    by any type or build check. */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setDeleteFor(target);
                    onClose();
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>

      {/* OUTSIDE the popover, deliberately — see the Delete button above. */}
      {deleteFor && (
        <DeleteItemButton
          key={deleteFor.id}
          id={deleteFor.id}
          make={deleteFor.make}
          model={deleteFor.model}
          serialNumber={deleteFor.serialNumber}
          holderName={deleteFor.holderName}
          autoOpen
          onClosed={() => setDeleteFor(null)}
        />
      )}
    </>
  );
}

/** Wiring for the row: returns the state and the `onContextMenu` handler. */
export function useItemRowContextMenu() {
  const [target, setTarget] = useState<ContextTarget | null>(null);
  const close = useCallback(() => setTarget(null), []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent, row: Omit<ContextTarget, "x" | "y">) => {
      // Desktop only, and never over a control the row already owns: a
      // right-click on a link or a button should keep the browser's own menu
      // ("Open link in new tab" on the View link is genuinely useful).
      if (!isDesktopWidth()) return;
      if ((e.target as HTMLElement).closest("a, button, input, select, textarea, dialog")) return;
      e.preventDefault();
      setTarget({ ...row, x: e.clientX, y: e.clientY });
    },
    [],
  );

  return { target, close, onContextMenu };
}
