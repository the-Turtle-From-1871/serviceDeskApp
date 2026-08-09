"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { AuditLight } from "@/components/AuditLight";
import { MarkReadyButton } from "@/components/MarkReadyButton";
import { ReadinessControls } from "@/components/ReadinessControls";
import { DeleteItemButton } from "@/components/DeleteItemButton";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import {
  READINESS_LABEL,
  ITEM_COLUMNS,
  estimateTextEm,
  parseHiddenCols,
  present,
  selectableIds,
  selectAllState,
  type ColumnKey,
  type ItemRow,
  type SortDir,
} from "@/components/items-view";
import { SortFilterMenu } from "@/components/SortFilterMenu";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import { useRowGestures } from "@/components/useRowGestures";
import { isCardLayout } from "@/components/swipe-row";
import type { SortKey } from "@/modules/items/items.service";

export type { ItemRow };

const HIDDEN_KEY = "items:hiddenCols";
// Category is hidden by default: the table already carries a lot of columns,
// and category is opt-in for people who work by device class. It stays
// filterable and sortable while hidden. (Only applies to new visitors — an
// existing stored preference wins over this default.)
const DEFAULT_HIDDEN: ColumnKey[] = ["deviceCategory"];
const hiddenStore = makeStore(HIDDEN_KEY, parseHiddenCols);

/** A value for the card's More panel, or the em-dash placeholder. `present`
 *  owns the "is this missing" rule (see items-view.ts); this only picks the
 *  mark. `/i/<id>`'s detail card keeps its own `dash` constant — the two
 *  surfaces render different components and share no styling, so they are
 *  deliberately not coupled through a shared node. */
function orDash(value: string | null | undefined) {
  return present(value) ?? <span className="subtle">—</span>;
}

// Re-export rather than redeclare: the shape is owned by listItems, which is
// what parses and consumes it.
export type { SortKey };

export function ItemSelectTable({
  items,
  isAdmin,
  q,
  sort,
  dir,
  page,
  totalPages,
  sortKeys,
  uic,
  uics,
  categories = [],
}: {
  items: ItemRow[];
  isAdmin: boolean;
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
  totalPages: number;
  sortKeys: SortKey[];
  uic: string | null;
  uics: string[];
  /** The managed DeviceCategory vocabulary, fetched ONCE server-side by the page
   *  and passed down — never a per-row lookup. Only used by the admin bulk
   *  controls in the selection bar. */
  categories?: { name: string }[];
}) {
  const router = useRouter();
  const secondarySort = sortKeys[1] ?? null;

  // Selection is a Map (id -> row), not a Set of ids, so it survives paging: the
  // receipt-group validation below needs each selected item's make/model, and an
  // item selected on page 1 is no longer in `items` once you page forward. You can
  // only ever select a row you can see, so its details are captured at select time.
  const [selected, setSelected] = useState<Map<string, ItemRow>>(new Map());
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const toggle = (row: ItemRow) =>
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(row.id)) n.delete(row.id);
      else n.set(row.id, row);
      return n;
    });

  const allState = useMemo(() => selectAllState(items, selectedIds), [items, selectedIds]);
  const selectableCount = useMemo(() => selectableIds(items).length, [items]);
  // "Select all" acts on the CURRENT page's selectable rows, leaving off-page
  // selections untouched.
  const toggleAll = () =>
    setSelected((prev) => {
      const n = new Map(prev);
      const pageActive = items.filter((it) => it.status === "ACTIVE");
      const allOnPage = pageActive.length > 0 && pageActive.every((it) => n.has(it.id));
      if (allOnPage) for (const it of pageActive) n.delete(it.id);
      else for (const it of pageActive) n.set(it.id, it);
      return n;
    });

  // View preferences (column visibility) persist to localStorage. Sort + paging are
  // URL-driven (server-side), so they are NOT stored here.
  const [hidden, setHidden] = usePersistedPref(hiddenStore, DEFAULT_HIDDEN);
  const isHidden = (key: ColumnKey) => hidden.includes(key);
  const visibleCols = ITEM_COLUMNS.filter((c) => !isHidden(c.key));

  const toggleCol = (key: ColumnKey) => {
    const next = new Set(hidden);
    if (next.has(key)) { next.delete(key); setHidden([...next]); return; }
    // Keep at least one data column visible.
    if (ITEM_COLUMNS.length - next.size <= 1) return;
    next.add(key);
    setHidden([...next]);
  };

  // Group validation runs over ALL selected items (every page), from the Map values.
  const groupCount = useMemo(
    () => new Set([...selected.values()].map((it) => `${it.make} ${it.model}`)).size,
    [selected],
  );
  const tooMany = groupCount > MAX_RECEIPT_ROWS;
  const maxGroupSize = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of selected.values()) {
      const key = `${it.make} ${it.model}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let max = 0;
    for (const n of counts.values()) if (n > max) max = n;
    return max;
  }, [selected]);
  const tooManyPerRow = maxGroupSize > MAX_ITEMS_PER_ROW;

  // Selection mode is DERIVED, not its own state: the phone shows checkboxes
  // and treats taps as toggles exactly when something is selected. A separate
  // `isSelecting` flag would be a second source of truth that could disagree
  // with the selection bar the user is looking at.
  const selecting = selected.size > 0;

  const gestures = useRowGestures({
    // Paging and sorting are `router.push` navigations within this route, so
    // this component stays mounted while `items` changes under it. Handing the
    // ids over lets the hook drop an open drawer that belongs to the previous
    // page rather than re-showing it here.
    rowIds: items.map((it) => it.id),
    // Swipe reveals Edit/Retire/Delete, all admin-only — a standard user's
    // drawer would be empty, so there is nothing to pull open. It is also off
    // while selecting, so the two gestures never compete for the same finger.
    swipeEnabled: isAdmin && !selecting,
    longPressEnabled: true,
    onLongPress: (id) => {
      const row = items.find((r) => r.id === id);
      // Retired rows render no checkbox and are excluded from every bulk
      // action (selectableIds), so a long press on one must not smuggle it
      // into the selection.
      if (row && row.status === "ACTIVE") toggle(row);
    },
  });

  // Entering selection mode retracts any open drawer: its buttons act on one
  // row, which is the opposite of what the selection bar is about to do.
  const { closeDrawer } = gestures;
  useEffect(() => {
    if (selecting) closeDrawer();
  }, [selecting, closeDrawer]);

  const renderRow = (it: ItemRow) => {
    const offset = gestures.offsetFor(it.id);
    // Trimmed once here rather than at each use: the More panel needs the
    // home unit's length for the fit sizing and the same string to render, and
    // SLOC needs the identical test for whether the row exists at all.
    const homeUnit = present(it.homeUnit);
    const storageLocation = present(it.storageLocation);
    return (
    <tr
      key={it.id}
      {...gestures.pointerHandlers(it.id)}
      style={{
        // Read by the mobile card rules in globals.css. This is the RESTING
        // position only — a live drag is written straight to the node by
        // useRowGestures and settles on this same value, so a swipe costs no
        // renders. Ignored above 720px, where nothing declares a transform.
        ["--swipe" as string]: `${offset}px`,
      }}
      onClickCapture={(e) => {
        // Only the card's own stretched link is ever intercepted. Buttons, the
        // checkbox and the drawer's actions are left completely alone — this
        // handler runs on desktop too, where the row is an ordinary table row.
        const link = (e.target as HTMLElement).closest?.("a.card-link");
        if (!link) return;
        if (gestures.consumeSuppressedClick(it.id)) {
          // A swipe or a long press produced this click, not a tap. Navigating
          // now would throw away the drawer or the selection just made.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (selecting && it.status === "ACTIVE" && isCardLayout()) {
          e.preventDefault();
          e.stopPropagation();
          toggle(it);
        }
      }}
    >
      <td className="cell-select" data-label="Select">{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it)} aria-label={`Select ${it.deviceName ?? ""} ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
      {!isHidden("deviceName") && <td className="cell-desktop" data-label="Device Name">{it.deviceName ? it.deviceName : <span className="subtle">—</span>}</td>}
      {!isHidden("make") && <td className="cell-desktop" data-label="Make">{it.make}</td>}
      {!isHidden("model") && <td className="cell-desktop" data-label="Model">{it.model}</td>}
      {!isHidden("serialNumber") && <td className="mono cell-desktop" data-label="Serial">{it.serialNumber}</td>}
      {!isHidden("holder") && <td className="cell-desktop" data-label="Holder">{it.holderName ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deviceUIC") && <td className="mono cell-desktop" data-label="UIC">{it.deviceUIC ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deviceCategory") && <td className="cell-desktop" data-label="Category">{it.deviceCategory ?? <span className="subtle">—</span>}</td>}
      {/* Derived server-side (readiness.query.ts), so no client-side narrowing
          of an untrusted stored value is needed — the row already carries a
          real ReadinessState. Accountability used to ride along here as a "Not
          accounted for" badge off Item.isAccountedFor; that flag is gone —
          the Audit column IS the accountability signal now. */}
      {!isHidden("readiness") && <td className="cell-desktop" data-label="Readiness">{READINESS_LABEL[it.readiness]}</td>}
      {!isHidden("status") && <td className="cell-desktop" data-label="Status"><StatusBadge status={it.status} /></td>}
      {!isHidden("auditState") && <td className="cell-desktop" data-label="Audit" style={{ textAlign: "center" }}><AuditLight state={it.auditState} /></td>}

      {/* ---- The mobile card, in three cells of its own ----
          Every cell above is hidden below 720px and these three replace them.
          They are deliberately NOT the same cells re-styled: each of those is
          rendered conditionally on the Columns menu, so a user who hid the
          Serial column would get a card with no heading and — because the
          heading carries the link — no way to open the item at all. Building
          the card from cells the column preferences cannot reach makes that
          unrepresentable. The cost is that the Columns menu shapes the desktop
          table only, which is the right place for it. */}
      <td className="mono cell-serial" data-label="Serial">
        {/* The stretched link: globals.css gives its ::after the whole row, so
            tapping anywhere on the card opens the item while the accessibility
            tree still sees one ordinary link with a real href. */}
        <Link
          href={`/i/${it.id}`}
          className="card-link"
          // A held link is a DRAGGABLE link on iOS, and the system drag that
          // starts cancels our pointer stream mid-press — see the
          // `-webkit-user-drag` note on .card-link. This is the same
          // instruction at the HTML level, for engines that ignore that
          // property. Dragging a row was never a feature here.
          draggable={false}
          aria-label={`View ${it.make} ${it.model}, serial ${it.serialNumber}`}
        >
          {it.serialNumber}
        </Link>
      </td>
      <td className="cell-primary" data-label="">
        <span className="cell-primary__name">{it.deviceName ? it.deviceName : <span className="subtle">Unnamed device</span>}</span>
        <span className="cell-primary__sub">{it.make} {it.model}</span>
      </td>
      <td className="cell-meta" data-label="">
        <span className="cell-meta__facts">
          <span className="subtle">{READINESS_LABEL[it.readiness]}</span>
          <StatusBadge status={it.status} />
          <AuditLight state={it.auditState} />
        </span>
        {/* Swipe is invisible without a hint — and a hint nobody can press is
            a gesture some people simply never find, so the tab is also the tap
            target that opens the same drawer. Absolutely positioned by
            globals.css onto the CARD's right edge — it anchors to the <tr>,
            which is the positioned ancestor, so it stays in this cell in the
            DOM while sitting at the card's vertical centre on screen.

            Rendered on exactly the condition `swipeEnabled` carries, so the
            tab is present precisely when the drawer it opens is reachable: an
            ordinary user's drawer is empty, and during selection mode the
            drawer is force-closed (see the effect above) — a tab that could
            re-open it there would fight that. */}
        {isAdmin && !selecting && (
          <button
            type="button"
            className="swipe-grip"
            // The tab is two bars of ink; its NAME is what it does. It is a
            // real control now, so it must not be aria-hidden — this is the
            // only non-visual route to the drawer on a phone.
            aria-label={gestures.openId === it.id ? "Hide actions" : "Show actions"}
            aria-expanded={gestures.openId === it.id}
            // Names the drawer this button controls. Note the drawer ALSO
            // slides in from CSS alone when focus lands inside it
            // (`tr:has(.row-actions … :focus-visible)` in globals.css), which
            // this button cannot know about — so `aria-expanded` describes the
            // tab's own state, not every way the drawer can be on screen.
            aria-controls={`row-actions-${it.id}`}
            onClick={() => {
              // A swipe that happens to lift off over the tab still
              // synthesises a click here. Spending the same suppression flag
              // the card link uses is what stops that click undoing the
              // gesture that produced it. `holdSuppresses: false` because the
              // tab does not navigate — see the note on the hook's type.
              if (gestures.consumeSuppressedClick(it.id, { holdSuppresses: false })) return;
              gestures.toggleDrawer(it.id);
            }}
          >
            <i /><i />
          </button>
        )}
      </td>

      {/* The custody and telemetry facts the compact card drops — Holder, Home
          unit, SLOC, Compliance, Last logon user, Last logon date — behind a
          chevron at the card's bottom edge.

          UIC and Category used to sit here in place of Home unit and the three
          MDM fields. Both were dropped deliberately: Category is a coarse device
          class the make/model on the card's face already implies, and the UIC is
          the same fact as Home unit in six characters that nobody reads aloud.
          Both remain desktop columns in the Columns menu for anyone who works by
          them. What replaced them is otherwise reachable only by opening the
          item, and it is what a technician checks when deciding whether a device
          is actually in use and where it should be.

          A native <details>, not a useState toggle: it opens before hydration,
          Enter/Space work on the <summary> for free, and the open state is the
          element's own so nothing has to be tracked per row in a component that
          re-renders on every selection change. It is deliberately NOT driven by
          the Columns menu — the card is built from cells the menu cannot reach
          (see cell-serial above), so this shows the same fields for everyone
          rather than a set that changes with a desktop preference.

          `summary` is in useRowGestures' pointerdown guard, so pressing the
          chevron cannot start a swipe or a long press, and globals.css lifts it
          above the stretched card link so the tap toggles instead of
          navigating. */}
      <td className="cell-more" data-label="">
        <details className="card-more">
          <summary className="card-more__toggle">
            <span className="card-more__label">More</span>
            {/* An icon, not a "⌄" glyph: a text chevron is positioned by font
                metrics, so it sits high in its em box and — once rotated 180°
                for the open state — lands visibly above the label. An SVG has
                a box we control. lucide is already this app's icon set. */}
            <ChevronDown className="card-more__chevron" aria-hidden="true" />
          </summary>
          <dl className="card-more__list">
            {/* Every value in this panel goes through `present`/`orDash`, so ONE
                rule decides what counts as missing. It used to be four idioms in
                forty lines — `??` here, `||` there, `.trim()` on one row — which
                disagree precisely where this data is messy: the CSV importer
                writes MDM columns verbatim, so an absent value arrives as null
                from some exports, "" from others and "   " from a few. `??`
                renders "" as a labelled blank that reads like a broken row, and
                an untrimmed check does the same for whitespace. */}
            <dt>Holder</dt>
            <dd>{orDash(it.holderName)}</dd>
            {/* Home unit reads like every other row — label and value on ONE
                line — but it is wrapped in its own flex row rather than sitting
                in the shared grid columns, and that is what buys the space to
                keep the value on one line too. The grid's label track is as wide
                as "LAST LOGON DATE" (114px at 390px), leaving 198px for a value
                that can run to 53 characters; on its own row the label costs
                only its own width, so the value gets ~270px instead. `<div>`
                between `<dl>` and `<dt>`/`<dd>` is valid HTML and keeps the
                name/value semantics a screen reader announces.

                The value's font is then sized to fit that width on one line.
                `--w` is the string's estimated width in em, from measured Geist
                glyph widths — NOT its character count. A count charges a comma
                and a W alike, and unit names are full of spaces, which is what
                pushed the font onto its floor and wrapped the line on a narrow
                phone. Estimated from the TRIMMED string, which is also what
                renders. Nothing is measured in JS: the panel lives in a closed
                <details> until tapped, so there is no layout to measure, on 50
                rows. See `.card-more__fit` in globals.css for the arithmetic. */}
            <div className="card-more__row">
              <dt className="card-more__fit-label">Home unit</dt>
              <dd className="card-more__fit">
                {homeUnit
                  ? <span style={{ ["--w" as string]: estimateTextEm(homeUnit) }}>{homeUnit}</span>
                  : orDash(null)}
              </dd>
            </div>
            {/* SLOC is the ONE row that disappears when it is empty, rather
                than showing a dash. Most of the catalogue has no storage
                location — a dash on nearly every card is a row of noise between
                the two facts either side of it. The others stay put even when
                blank: a missing holder, home unit or logon is itself worth
                seeing, and a row that came and went would make two cards
                impossible to compare at a glance. */}
            {storageLocation ? (
              <>
                <dt>SLOC</dt>
                <dd>{storageLocation}</dd>
              </>
            ) : null}
            <dt>Compliance</dt>
            <dd>{orDash(it.compliance)}</dd>
            <dt>Last logon user</dt>
            <dd className="mono">{orDash(it.lastLogonUserPrincipalName)}</dd>
            <dt>Last logon date</dt>
            <dd>{orDash(it.lastLogonDate)}</dd>
          </dl>
        </details>
      </td>

      <td className="row-actions" data-label="" id={`row-actions-${it.id}`}>
        <div className="actions actions--end">
          <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm action-view">View</Link>
          {isAdmin && <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>}
          {isAdmin && (
            <form action={toggleItemStatusAction}>
              <input type="hidden" name="id" value={it.id} />
              <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
              <button type="submit" className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}>{it.status === "RETIRED" ? "Reactivate" : "Retire"}</button>
            </form>
          )}
          {isAdmin && (
            <DeleteItemButton
              id={it.id}
              make={it.make}
              model={it.model}
              serialNumber={it.serialNumber}
              holderName={it.holderName}
              // Retract the drawer when the modal opens. This is an
              // INTERACTION choice, not a safety mechanism: `closeDrawer` is a
              // setState and `showModal()` runs in the same handler, so the row
              // is still transformed at the moment the dialog enters the top
              // layer — the ordering an earlier version of this comment claimed
              // does not exist. It does not need to: a top-layer element's
              // containing block is the viewport regardless of an ancestor's
              // transform, measured here at a 390px viewport (dialog at left 0,
              // full width, with the row sitting at -180px).
              onOpen={closeDrawer}
            />
          )}
        </div>
      </td>
    </tr>
    );
  };

  const selectedKeys = () => [...selected.keys()].join(",");
  const create = () => { if (selected.size && !tooMany && !tooManyPerRow) router.push(`/receipts/new?items=${selectedKeys()}`); };
  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`, "_blank", "noopener"); };

  // Build a /items URL preserving the current query, overriding only what changes.
  // Changing the sort/filter resets to page 1; paging keeps them.
  //
  // Compound sort travels as parallel comma lists (`sort=make,serialNumber` +
  // `dir=asc,asc`) — the server pairs them positionally, so the two lists must
  // always be written together and in the same order.
  const hrefFor = (over: {
    keys?: SortKey[];
    page?: number;
    uic?: string | null;
  }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);

    const nextKeys = over.keys ?? sortKeys;
    if (nextKeys.length > 0) {
      params.set("sort", nextKeys.map((k) => k.key).join(","));
      params.set("dir", nextKeys.map((k) => k.dir).join(","));
    }

    const nextUic = over.uic !== undefined ? over.uic : uic;
    if (nextUic) params.set("uic", nextUic);

    const nextPage = over.page ?? page;
    if (nextPage > 1) params.set("page", String(nextPage));

    const s = params.toString();
    return s ? `/items?${s}` : "/items";
  };
  const navigate = (over: Parameters<typeof hrefFor>[0]) => router.push(hrefFor(over));

  /** Replace the primary sort, keeping any secondary key that isn't now a duplicate. */
  const setPrimary = (key: string | null) => {
    if (!key) return navigate({ keys: [], page: 1 });
    const kept = sortKeys.slice(1).filter((k) => k.key !== key);
    navigate({ keys: [{ key, dir }, ...kept], page: 1 });
  };
  const setSecondary = (key: string | null) => {
    if (sortKeys.length === 0) return;
    const primary = sortKeys[0];
    navigate({ keys: key ? [primary, { key, dir: "asc" }] : [primary], page: 1 });
  };
  /** Set the primary key's direction outright rather than flipping it: the menu
   *  offers Ascending and Descending as two radios, so it asks for a specific
   *  direction and re-picking the current one must be a no-op, not a reversal. */
  const setPrimaryDir = (next: SortDir) => {
    if (sortKeys.length === 0 || next === sortKeys[0].dir) return;
    const [first, ...rest] = sortKeys;
    navigate({ keys: [{ ...first, dir: next }, ...rest], page: 1 });
  };
  const setUic = (next: string | null) => navigate({ uic: next, page: 1 });

  return (
    <>
      <div className="toolbar" style={{ gap: 8, alignItems: "flex-end" }}>
        {/* Sort by / Direction / Then by / Unit were four separate controls
            here. On a phone they wrapped into three rows of chrome above the
            first result, so they are one button and one panel now — see
            SortFilterMenu. The URL-building stays on THIS side: `sort` and
            `dir` travel as positionally-paired comma lists, and hrefFor is the
            only thing that writes them. */}
        <SortFilterMenu
          sort={sort}
          dir={dir}
          secondary={secondarySort?.key ?? null}
          uic={uic}
          uics={uics}
          onPrimary={setPrimary}
          onDir={setPrimaryDir}
          onSecondary={setSecondary}
          onUic={setUic}
        />
        {isAdmin && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size === 0}
            onClick={printQr}
            title={selected.size === 0 ? "Select items to print QR labels" : undefined}
          >
            {/* The label is CONSTANT on purpose. It used to append ` (N)`, and
                on a phone this button and Columns share one fixed-width row —
                so the suffix appearing widened this button by 8.9px and shrank
                Columns by exactly that much, then jittered again at (10) and
                (100). The count is not lost: the selection bar below reads
                "N selected · N rows", and it is on screen under precisely the
                same condition (selected.size > 0), so this was showing the same
                number twice at the cost of the toolbar resizing. Measured at
                390px. */}
            Print QR codes
          </button>
        )}
        <details className="col-menu spacer">
          <summary className="btn btn-secondary">Columns</summary>
          <div className="col-menu-panel">
            {ITEM_COLUMNS.map((c) => {
              const shown = !isHidden(c.key);
              const lastVisible = shown && visibleCols.length <= 1;
              return (
                <label key={c.key} title={lastVisible ? "At least one column must stay visible" : undefined}>
                  <input type="checkbox" checked={shown} disabled={lastVisible} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
      </div>

      {/* Rendered below the toolbar, so the controls that produced an empty
          result stay on screen and the filter can be undone. */}
      {items.length === 0 && (
        <div className="card empty stack">
          <div>No items match {uic ? "this unit and " : ""}your search.</div>
          {/* Admin-only because creation is admin-only (createItemAction calls
              requireAdmin) — the server check is the authority, this is
              presentation. Deliberately NOT suppressed while a uic filter is
              active: q + uic can return nothing for an item that exists under a
              DIFFERENT uic, so this can be clicked for a serial already in the
              book. That is accepted — the action's P2002 branch names the
              collision and links to the item — because an admin filtered to a
              unit may legitimately be adding a device. */}
          {isAdmin && q.trim() && (
            <Link
              href={`/admin/items/new?serialNumber=${encodeURIComponent(q.trim())}${uic ? `&uic=${encodeURIComponent(uic)}` : ""}`}
              className="btn btn-secondary btn-sm"
            >
              <span className="truncate-inline">
                + Create &ldquo;{q.trim()}&rdquo; as a new item
              </span>
            </Link>
          )}
        </div>
      )}

      <div className="table-wrap" hidden={items.length === 0}>
        {/* `table--cards` opts THIS table into the mobile card treatment
            (swipe drawer, tap-to-open, the three card cells). It is a class
            rather than a change to `.table` because every other table in the
            app still wants the plain restacked-row layout — receipts, the
            audit log and the receipt builder have no per-row drawer and no
            single obvious destination for a tap. */}
        <table className={`table table--cards${selecting ? " is-selecting" : ""}`}>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allState === "all"}
                  disabled={selectableCount === 0}
                  // React has no `indeterminate` prop — it is a DOM-only property.
                  ref={(el) => { if (el) el.indeterminate = allState === "some"; }}
                  onChange={toggleAll}
                  aria-label={allState === "all" ? "Deselect all items on this page" : "Select all items on this page"}
                  title={selectableCount === 0 ? "No selectable items" : undefined}
                />
              </th>
              {visibleCols.map((c) => (
                <th key={c.key} style={c.key === "auditState" ? { textAlign: "center" } : undefined}>{c.label}{sort === c.key ? (dir === "asc" ? " ▲" : " ▼") : ""}</th>
              ))}
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(renderRow)}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="row" style={{ justifyContent: "center", gap: 12, alignItems: "center" }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => navigate({ page: page - 1 })}>← Prev</button>
          <span className="subtle">Page {page} of {totalPages}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => navigate({ page: page + 1 })}>Next →</button>
        </div>
      )}

      {selected.size > 0 && (
        // zIndex keeps this bar above the table rows it floats over.
        <div className="card stack-sm" style={{ position: "sticky", bottom: 0, zIndex: 2 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span>{selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}</span>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {tooMany
                ? <span role="alert" className="alert-error">Too many item types ({groupCount}). Max {MAX_RECEIPT_ROWS} per receipt — split into two.</span>
                : tooManyPerRow
                ? <span role="alert" className="alert-error">Too many of one item ({maxGroupSize}). Max {MAX_ITEMS_PER_ROW} per row — split into two.</span>
                : <button className="btn btn-primary" onClick={create}>Create receipt from {selected.size} selected</button>}
              {/* The only way out of selection mode on a phone. `selecting` is
                  derived from selected.size, and on the card layout every tap
                  on an ACTIVE card toggles instead of opening — so with the
                  <thead> checkbox hidden below 720px and selections surviving
                  paging, a selection made on page 1 left no reachable control
                  to undo it once you paged away. Reload was the only exit. */}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSelected(new Map())}
              >
                Clear selection
              </button>
            </div>
          </div>
          {/* The bulk "Set accountability" select is gone for good —
              accountability comes from audit evidence (record an audit
              instead), never from a checkbox.

              "Set readiness" is back, but it does NOT store a readiness value:
              it writes the underlying signals readiness.ts derives from
              (markedReadyAt, Item.status), and refuses the two states that are
              observed rather than asserted. See ReadinessControls. The
              one-click "Mark as on hand" stays as the fast path and routes
              through the same markItemsReady service function. */}
          {/* One wrapping row, NOT the card's default vertical stack: this bar is
              sticky and overlays the table, so every line of height hides another
              row of what you are selecting from. Stacked, it covered a phone
              viewport entirely. `flex-end` bottom-aligns the one-click button
              with the Apply buttons, whose selects carry a label above them. */}
          {isAdmin && (
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <MarkReadyButton
                itemIds={[...selected.keys()]}
                onDone={() => setSelected(new Map())}
              />
              {/* No onDone: unlike "Mark as on hand", these controls keep the
                  selection so their outcome message survives (clearing it
                  unmounts this whole bar), and so readiness and category can be
                  applied in one pass. */}
              <ReadinessControls
                itemIds={[...selected.keys()]}
                categories={categories}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
