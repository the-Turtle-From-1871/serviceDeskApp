"use client";

import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { SortDir } from "@/components/column-view";

/**
 * The "Sort & filter" popup menu, shared by /items and the service queue.
 *
 * Replaces several separate toolbar controls — a Sort by select, an Asc/Desc
 * button, and each page's own filter select — with one button that reads its own
 * state back and opens a panel holding them all.
 *
 * PRESENTATIONAL, and deliberately knows nothing about either page's data. It
 * takes its column list, its filter and its own summary TEXT as props, so it
 * never imports `items-view` or `service-queue-view` — one page's vocabulary
 * cannot leak into the other, and neither list can drift from the sort its own
 * page actually applies. It never builds a URL either: on /items, `sort` and
 * `dir` travel to the server as parallel comma lists paired positionally and
 * ItemSelectTable's `hrefFor` owns that contract; the queue sorts client-side
 * and holds its state in a persisted pref. A second writer is exactly how those
 * drift, so this component only calls back.
 *
 * The two pages differ in what they hand it, not in how it behaves:
 *   /items — 9 sortable columns, a Unit (UIC) filter, and a "Then by" tie-break.
 *   /queue — 5 sortable columns and a Service type filter. NO "Then by":
 *            `sortQueueRows` takes a single key, so offering a tie-breaker would
 *            be a control that silently does nothing.
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

/** Rendered once per page, so a plain prefix rather than `useId` — these have to
 *  be exact `popovertarget` references AND exact CSS selectors, and useId's
 *  generated ids carry delimiters that are awkward in a selector.
 *
 *  The id is what globals.css styles the popover BY — `#items-sortfilter,
 *  #queue-sortfilter` — precisely so no shared class can grow a `display` later
 *  and re-create the closed-popover trap described above. So a new caller must
 *  add its id to those rule groups; there is no class to inherit them from. */
export type MenuIdPrefix = "items" | "queue";

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
 *
 * EXPORTED so `BulkActionsMenu` (the /items selection bar's "More actions"
 * sheet) can share it. It is the only implementation of this fix in the app and
 * must stay so: a second copy is how one of them silently loses the capture
 * phase again. Each caller registers its own listeners keyed on its own ids, so
 * two menus on one page do not interfere — each ignores a tap while its own
 * popover is closed.
 */
export function useDismissSwallowsTap(menuId: string, triggerId: string) {
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

/** One optional filter select, above the sort fields. `/items` passes the unit
 *  (UIC) list; the queue passes its service types. The NEUTRAL option is part of
 *  `options`, not synthesised here — the two pages spell it differently ("" for
 *  all units, "ALL" for all types) and inventing one would mean this component
 *  deciding what "no filter" means for a page it knows nothing about. */
export type MenuFilter = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

/** One optional ONE-WAY filter, rendered as a checkbox. Unchecked means "no
 *  filter", never "show me the complement" — which is why it is not a
 *  two-option `MenuFilter`: a select implies both directions are meaningful,
 *  and "devices that do NOT need renaming" is not a list anyone wants. */
export type MenuToggle = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Inert because something else already decides this filter — `/items`
   *  disables the unnamed toggle while a search is running, because a search
   *  lifts that hide regardless of the box. A control that re-renders an
   *  identical list reads as a failed click, so it must not stay live and
   *  silent. Optional: a toggle with nothing overriding it omits both fields. */
  disabled?: boolean;
  /** Why it is inert, rendered beneath the label. Meaningless without
   *  `disabled` — a disabled control with no reason is just a dead one. */
  disabledNote?: string;
};

export function SortFilterMenu({
  idPrefix,
  columns,
  summary,
  sort,
  dir,
  secondary,
  filter,
  toggles,
  onPrimary,
  onDir,
  onSecondary,
}: {
  idPrefix: MenuIdPrefix;
  /** The sortable columns to offer. Each page passes the list its OWN sort
   *  actually accepts, so a column offered here can never be one that gets
   *  silently dropped. */
  columns: readonly { key: string; label: string }[];
  /** The trigger's read-back text, computed by the caller from its own labels. */
  summary: string;
  /** The PRIMARY sort key, or null for the default (newest) order. */
  sort: string | null;
  dir: SortDir;
  /** The tie-breaker key, or null. OMIT `onSecondary` to hide "Then by"
   *  entirely — a page whose sort takes one key must not offer a second. */
  secondary?: string | null;
  filter?: MenuFilter;
  /** Zero or more optional ONE-WAY filters, each rendered as a checkbox rather
   *  than a select. A select needs a vocabulary; each of these is a worklist
   *  narrowing ("only the rows that need attention"), where unchecked means "no
   *  filter" and not "only the rows that are fine" — so a two-option select
   *  would offer a third state the data cannot express. Omit it entirely (or
   *  pass an empty array) and nothing renders; the service queue passes none. */
  toggles?: MenuToggle[];
  onPrimary: (key: string | null) => void;
  onDir: (dir: SortDir) => void;
  onSecondary?: (key: string | null) => void;
}) {
  const menuId = `${idPrefix}-sortfilter`;
  const triggerId = `${idPrefix}-sortfilter-trigger`;
  useDismissSwallowsTap(menuId, triggerId);

  // A tie-breaker with nothing to break is meaningless, and the default
  // (newest) order has no ties worth resolving — so Direction and Then by are
  // inert until a primary key is chosen. This is the same rule the old toolbar
  // enforced with `disabled={!sort}` on both controls.
  const noPrimary = !sort;

  return (
    <>
      <button
        type="button"
        id={triggerId}
        className="btn btn-secondary menu-trigger"
        popoverTarget={menuId}
      >
        <span className="menu-trigger__label">Sort &amp; filter</span>
        {/* The state, read back with the menu CLOSED. Without it the toolbar
            stops answering "what order am I looking at?" — which the separate
            selects used to answer just by being on screen. */}
        <span className="menu-trigger__value truncate-inline">{summary}</span>
        {/* An SVG, not a "⌄" glyph: a text chevron is placed by font metrics and
            sits high in its em box. Same reasoning as the card's More arrow. */}
        <ChevronDown className="menu-trigger__chevron" aria-hidden="true" />
      </button>

      {/* NO className on this element. See the trap note above. */}
      <div id={menuId} popover="auto">
        <div className="popup-menu__panel">
          {/* Only offered when there is something to filter BY — /items passes
              no filter at all when the page has no units, and a lone "All units"
              option is a control that cannot change anything. */}
          {filter && filter.options.length > 1 && (
            <Field label={filter.label}>
              <select
                className="select"
                value={filter.value}
                onChange={(e) => filter.onChange(e.target.value)}
              >
                {filter.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          )}

          {/* A checkbox each, not a Field+select: the label belongs BESIDE the
              box, and the 44px tap floor has to come from the row rather than
              the input, which iOS sizes itself. Keyed on the label — these are
              a fixed, caller-supplied list rather than something reordered at
              runtime. */}
          {toggles?.map((t) => (
            <label key={t.label} className="popup-menu__check">
              <input
                type="checkbox"
                checked={t.checked}
                disabled={t.disabled}
                onChange={(e) => t.onChange(e.target.checked)}
              />
              <span>
                {t.label}
                {t.disabled && t.disabledNote && (
                  <span className="subtle popup-menu__check-note">{t.disabledNote}</span>
                )}
              </span>
            </label>
          ))}

          <Field label="Sort by">
            <select
              className="select"
              value={sort ?? ""}
              onChange={(e) => onPrimary(e.target.value || null)}
            >
              <option value="">Default (newest)</option>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
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
              collapses a duplicate to its first occurrence anyway.
              Rendered only when the caller supplies a handler: the queue's
              sortQueueRows takes ONE key, so a tie-breaker there would be a
              control that changes nothing. */}
          {onSecondary && (
            <Field label="Then by">
              <select
                className="select"
                value={secondary ?? ""}
                disabled={noPrimary}
                onChange={(e) => onSecondary(e.target.value || null)}
              >
                <option value="">—</option>
                {columns.filter((c) => c.key !== sort).map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </Field>
          )}

          {/* Sheet-only (hidden above 720px by globals.css). A bottom sheet
              needs a close affordance a thumb can reach; the desktop dropdown
              has Escape and click-outside in plain sight. `popovertargetaction`
              means this costs no handler and no state. */}
          <div className="popup-menu__footer">
            <button
              type="button"
              className="btn btn-secondary"
              popoverTarget={menuId}
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
