"use client";

import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { SORTABLE_COLUMNS, sortFilterSummary, type SortDir } from "@/components/items-view";

/**
 * The /items toolbar's "Sort & filter" popup menu.
 *
 * Replaces four separate toolbar controls — the Sort by select, the Asc/Desc
 * button, the Then by select and the Unit (UIC) select — with one button that
 * reads its own state back and opens a panel holding all four.
 *
 * PRESENTATIONAL. It never builds a URL: `sort` and `dir` travel to the server
 * as parallel comma lists paired positionally, and ItemSelectTable's `hrefFor`
 * owns that contract. A second writer is exactly how the two lists drift out of
 * step, so this component only calls back.
 *
 * ── The trap this is built around ──────────────────────────────────────────
 * The UA hides a closed popover with `[popover]:not(:popover-open) { display:
 * none }`, and ANY author `display` rule beats it. That is bit-for-bit the
 * closed-<dialog> bug this page already shipped: `.card` sets `display: block`
 * and `.stack` sets `display: flex`, so 50 closed dialogs rendered at once and
 * swallowed the taps meant for the Delete buttons. So the element carrying
 * `popover` carries NO layout class — everything lives on `.popup-menu__panel`,
 * one level in. `DeleteItemButton` uses the same split for its dialog.
 *
 * ── Four native <select>s, not radio lists ─────────────────────────────────
 * The panel used to be four groups of radios — 27 rows, which scrolled on a
 * phone and buried Direction and Then by below the fold. Native selects collapse
 * it to four controls that fit without scrolling, and on iOS each opens the
 * system wheel picker, which handles a long unit list far better than a scrolling
 * radio list inside a scrolling sheet. `popovertarget` still supplies the
 * implicit `aria-expanded`/`aria-details` pair, focus-order insertion, Escape
 * with focus returned to the invoker, and light dismiss.
 */

/** Rendered once per page, so plain constants rather than `useId` — these have
 *  to be exact `popovertarget` / `aria-labelledby` references, and useId's
 *  generated ids carry delimiters that are awkward in a selector. */
const MENU_ID = "items-sortfilter";
const TRIGGER_ID = "items-sortfilter-trigger";

/**
 * Spend the first tap OUTSIDE the open panel on closing it, and nothing else.
 *
 * The Popover API light-dismisses on `pointerdown` but then lets the `click`
 * through to whatever was underneath — so on `/items` a tap meant to close the
 * menu also pressed "Import CSV" or "+ Log new item" sitting behind it. That is
 * the platform default, not a styling bug, and the only fix is to swallow the
 * click the dismissal produced.
 *
 * Same shape as `useRowGestures`' rule that a tap dismissing another row's
 * drawer is spent on the dismissal: decide at `pointerdown` (before the browser
 * closes the popover, while `:popover-open` still answers truthfully), then
 * cancel the resulting click in the CAPTURE phase so it never reaches the
 * control's own handler or a link's default.
 *
 * The trigger is excluded — its own click is what toggles the panel shut, and
 * swallowing that would leave the button dead while open.
 */
function useDismissSwallowsTap(menuId: string, triggerId: string) {
  const swallow = useRef(false);

  useEffect(() => {
    const isOutside = (target: EventTarget | null) => {
      const menu = document.getElementById(menuId);
      // `matches` rather than a state flag: the browser may already have
      // dismissed the popover by other means, and this must agree with it.
      if (!menu || !menu.matches(":popover-open")) return false;
      const node = target instanceof Node ? target : null;
      if (!node) return false;
      if (menu.contains(node)) return false;
      const trigger = document.getElementById(triggerId);
      if (trigger?.contains(node)) return false;
      return true;
    };

    const onPointerDown = (e: PointerEvent) => { swallow.current = isOutside(e.target); };
    const onClick = (e: MouseEvent) => {
      if (!swallow.current) return;
      swallow.current = false;
      // preventDefault alone is not enough — it stops a link navigating but not
      // a React onClick from firing. stopPropagation in the capture phase is
      // what keeps the tap from reaching the button underneath.
      e.preventDefault();
      e.stopPropagation();
    };
    // A pointerdown that never becomes a click (a drag, a scroll) must not leave
    // the flag armed to eat some later, unrelated click.
    const clear = () => { swallow.current = false; };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointercancel", clear, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointercancel", clear, true);
    };
  }, [menuId, triggerId]);
}

export function SortFilterMenu({
  sort,
  dir,
  secondary,
  uic,
  uics,
  onPrimary,
  onDir,
  onSecondary,
  onUic,
}: {
  /** The PRIMARY sort key, or null for the server's default (newest) order. */
  sort: string | null;
  dir: SortDir;
  /** The tie-breaker key, or null. */
  secondary: string | null;
  uic: string | null;
  uics: string[];
  onPrimary: (key: string | null) => void;
  onDir: (dir: SortDir) => void;
  onSecondary: (key: string | null) => void;
  onUic: (uic: string | null) => void;
}) {
  useDismissSwallowsTap(MENU_ID, TRIGGER_ID);

  // A tie-breaker with nothing to break is meaningless, and the default
  // (newest) order has no ties worth resolving — so Direction and Then by are
  // inert until a primary key is chosen. This is the same rule the old toolbar
  // enforced with `disabled={!sort}` on both controls.
  const noPrimary = !sort;
  const activeUic = uic?.trim() ? uic : null;

  return (
    <>
      <button
        type="button"
        id={TRIGGER_ID}
        className="btn btn-secondary menu-trigger"
        popoverTarget={MENU_ID}
      >
        <span className="menu-trigger__label">Sort &amp; filter</span>
        {/* The state, read back with the menu CLOSED. Without it the toolbar
            stops answering "what order am I looking at?" — which the four
            selects used to answer just by being on screen. */}
        <span className="menu-trigger__value truncate-inline">{sortFilterSummary(sort, dir, uic)}</span>
        {/* An SVG, not a "⌄" glyph: a text chevron is placed by font metrics and
            sits high in its em box. Same reasoning as the card's More arrow. */}
        <ChevronDown className="menu-trigger__chevron" aria-hidden="true" />
      </button>

      {/* NO className on this element. See the trap note above. */}
      <div id={MENU_ID} popover="auto">
        <div className="popup-menu__panel">
          {/* Only offered when there is something to filter by. A lone "All
              units" option is a control that cannot change anything. */}
          {uics.length > 0 && (
            <Field label="Unit">
              <select
                className="select"
                value={activeUic ?? ""}
                onChange={(e) => onUic(e.target.value || null)}
              >
                <option value="">All units</option>
                {uics.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          )}

          <Field label="Sort by">
            <select
              className="select"
              value={sort ?? ""}
              onChange={(e) => onPrimary(e.target.value || null)}
            >
              <option value="">Default (newest)</option>
              {SORTABLE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>

          <Field label="Direction">
            <select
              className="select"
              value={dir}
              disabled={noPrimary}
              onChange={(e) => onDir(e.target.value === "asc" ? "asc" : "desc")}
            >
              <option value="asc">Ascending ▲</option>
              <option value="desc">Descending ▼</option>
            </select>
          </Field>

          {/* Compound sort: "Make, then Serial". The primary key is excluded —
              ordering within itself resolves nothing, and parseSortKeys
              collapses a duplicate to its first occurrence anyway. */}
          <Field label="Then by">
            <select
              className="select"
              value={secondary ?? ""}
              disabled={noPrimary}
              onChange={(e) => onSecondary(e.target.value || null)}
            >
              <option value="">—</option>
              {SORTABLE_COLUMNS.filter((c) => c.key !== sort).map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </Field>

          {/* Sheet-only (hidden above 720px by globals.css). A bottom sheet
              needs a close affordance a thumb can reach; the desktop dropdown
              has Escape and click-outside in plain sight. `popovertargetaction`
              means this costs no handler and no state. */}
          <div className="popup-menu__footer">
            <button
              type="button"
              className="btn btn-secondary"
              popoverTarget={MENU_ID}
              popoverTargetAction="hide"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** A labelled control. A real <label> wrapping its select, so the caption is the
 *  select's accessible name with no id plumbing — and so tapping the caption
 *  opens the picker, which on a phone is most of the target. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="popup-menu__field">
      <span className="popup-menu__legend">{label}</span>
      {children}
    </label>
  );
}
