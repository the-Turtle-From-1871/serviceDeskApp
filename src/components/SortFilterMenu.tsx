"use client";

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
 * ── Why native radios and not role="menu" ──────────────────────────────────
 * APG's menu-button pattern (`role="menu"` + `menuitemradio`) is the textbook
 * answer for a sort picker, and honouring it means hand-building roving
 * tabindex, arrow keys and typeahead. A half-built `role="menu"` is worse than
 * none: the role promises AT users keyboard behaviour that then is not there.
 * Radios grouped by `name` give arrow-key navigation within a group, checked
 * state and group semantics for free — and it mirrors the Columns menu beside
 * it, which is native checkboxes in a panel. Columns = choose many, this =
 * choose one.
 *
 * `popovertarget` is what supplies the implicit `aria-expanded` / `aria-details`
 * pair, focus-order insertion, Escape-with-focus-return and click-outside. None
 * of that is hand-written here, and none of it exists on the <details>-based
 * Columns menu.
 */

/** Rendered once per page, so plain constants rather than `useId` — these have
 *  to be exact `popovertarget` / `aria-labelledby` references, and useId's
 *  generated ids carry delimiters that are awkward in a selector. */
const MENU_ID = "items-sortfilter";
const TRIGGER_ID = "items-sortfilter-trigger";

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
              units" radio is a control that cannot change anything. */}
          {uics.length > 0 && (
            <Group id="sf-unit" label="Unit">
              <Option name="sf-uic" checked={!activeUic} onSelect={() => onUic(null)}>
                All units
              </Option>
              {uics.map((u) => (
                <Option key={u} name="sf-uic" checked={activeUic === u} onSelect={() => onUic(u)}>
                  {u}
                </Option>
              ))}
            </Group>
          )}

          <Group id="sf-sort" label="Sort by">
            <Option name="sf-sort" checked={noPrimary} onSelect={() => onPrimary(null)}>
              Default (newest)
            </Option>
            {SORTABLE_COLUMNS.map((c) => (
              <Option key={c.key} name="sf-sort" checked={sort === c.key} onSelect={() => onPrimary(c.key)}>
                {c.label}
              </Option>
            ))}
          </Group>

          <Group id="sf-dir" label="Direction">
            <Option name="sf-dir" checked={dir === "asc"} disabled={noPrimary} onSelect={() => onDir("asc")}>
              Ascending ▲
            </Option>
            <Option name="sf-dir" checked={dir === "desc"} disabled={noPrimary} onSelect={() => onDir("desc")}>
              Descending ▼
            </Option>
          </Group>

          {/* Compound sort: "Make, then Serial". The primary key is excluded —
              ordering within itself resolves nothing, and parseSortKeys
              collapses a duplicate to its first occurrence anyway. */}
          <Group id="sf-then" label="Then by">
            <Option name="sf-then" checked={!secondary} disabled={noPrimary} onSelect={() => onSecondary(null)}>
              —
            </Option>
            {SORTABLE_COLUMNS.filter((c) => c.key !== sort).map((c) => (
              <Option
                key={c.key}
                name="sf-then"
                checked={secondary === c.key}
                disabled={noPrimary}
                onSelect={() => onSecondary(c.key)}
              >
                {c.label}
              </Option>
            ))}
          </Group>

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

/** One labelled set of radios. A plain div with `role="radiogroup"`, NOT a
 *  <fieldset>/<legend>: preflight is deliberately absent in this app, so those
 *  arrive with UA border and padding and the legend's own box quirks, and they
 *  buy nothing here — radios are grouped for keyboard and selection by their
 *  shared `name`, not by the fieldset. Disabled state therefore rides on each
 *  input rather than on `<fieldset disabled>`. */
function Group({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="popup-menu__group" role="radiogroup" aria-labelledby={`${id}-label`}>
      <p className="popup-menu__legend" id={`${id}-label`}>{label}</p>
      {children}
    </div>
  );
}

function Option({
  name,
  checked,
  disabled,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="popup-menu__option">
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} />
      <span>{children}</span>
    </label>
  );
}
