import { sortRows, parseSortPref as parseSortPrefGeneric, parseHiddenCols as parseHiddenColsGeneric, type SortDir, type SortPref as GenericSortPref } from "@/components/column-view";
import type { AuditState } from "@/modules/audit/audit.status";
import { READINESS_LABEL, type ReadinessState } from "@/modules/items/readiness";

export type { SortDir };

/** Columns the SERVER can order by. Most map to a stored column; `auditState`
 *  and `readiness` are derived and route through listItems' own mappings (a
 *  denormalized column and a raw-SQL ORDER BY respectively).
 *
 *  Re-exported from the leaf module the SERVER derives its allowlist from, so
 *  the two cannot drift: a column offered here that parseSortKeys does not
 *  accept is now a compile error rather than a sort that silently falls back to
 *  the default order. `sort-keys` imports nothing, so this pulls no Prisma into
 *  the client bundle. */
export type { SortField } from "@/modules/items/sort-keys";
import type { SortField } from "@/modules/items/sort-keys";

/** Every column the table can render.
 *
 *  NO LONGER identical to SortField. `holder` is displayed but not
 *  server-sortable: the current holder comes from a two-join custody lookup
 *  (modules/transfers/holders.query.ts) with no column for Prisma to name, and
 *  it is deliberately NOT a third derived sort key — that would mean a scalar
 *  subquery in the raw ORDER BY, its own parity coverage and a nulls decision.
 *  Sortability is the SORTABLE_COLUMNS list below; visibility is this one.
 *
 *  `lastSyncDateTime` is the second such column, for a different reason:
 *  it HAS a real column, but it holds the MDM export's raw text
 *  ("8/9/2026 6:02:11 AM"), so `ORDER BY` on it sorts lexically — 10/1/2025
 *  ahead of 7/25/2026. A sort that confidently returns the wrong order is
 *  worse than no sort, and the honest fix is a parsed twin (as lastLogonAt is
 *  to lastLogonDate), not an ORDER BY on the text. */
export type ColumnKey = SortField | "holder" | "lastSyncDateTime";

/* Readiness labels have ONE definition, in modules/items/readiness.ts, next to
   the function that derives them. Re-exported here so the table imports its
   vocabulary from this module like everything else, without a second copy that
   could drift. */
export { READINESS_LABEL };
export type { ReadinessState };

export type ItemRow = {
  id: string;
  deviceName: string | null;
  make: string;
  model: string;
  serialNumber: string;
  status: "ACTIVE" | "RETIRED";
  auditState: AuditState | null;
  deviceUIC: string | null;
  deviceCategory: string | null;
  /** Derived server-side for the whole page in one query — never per row.
   *  See modules/items/readiness.query.ts. */
  readiness: ReadinessState;
  /** The recipient named on this item's current hand receipt — open, with this
   *  row unreturned. Null when nothing holds it. Derived server-side for the
   *  whole page in one query — never per row. See
   *  modules/transfers/holders.query.ts. */
  holderName: string | null;
  /** The owning unit, shown in the phone card's More panel. Free text and often
   *  long ("HHC, 1-506 IN, 1BCT"), which is why the panel sizes it to fit — see
   *  `.card-more__fit` in globals.css. There is no Home unit COLUMN: the desktop
   *  table shows the UIC instead, which is the same fact in six characters. */
  homeUnit: string | null;
  /** Where the device physically sits when nobody holds it. Free text. */
  storageLocation: string | null;
  /* MDM telemetry, shown in the phone card's More panel. All four are stored
     VERBATIM as text by the importer (`lastLogonDate` is a raw string like
     "7/25/2026 1:40:21 AM", never a Date) — so they are rendered as-is, exactly
     as the item detail card does. `Item.lastLogonAt` is the parsed twin and is
     deliberately NOT here: it exists for readiness/SQL comparisons, and
     displaying a reformatted date beside the MDM export people cross-check
     against would invent a value the source never gave. */
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  compliance: string | null;
  /* When MDM last checked in with the device — NOT when a person last signed
     in. The only one of the four that is also a desktop column. */
  lastSyncDateTime: string | null;
};

export type SortPref = GenericSortPref<SortField>;

export const ITEM_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "holder", label: "Holder" },
  { key: "deviceUIC", label: "UIC" },
  { key: "deviceCategory", label: "Category" },
  { key: "readiness", label: "Readiness" },
  { key: "status", label: "Status" },
  { key: "auditState", label: "Audit" },
  { key: "lastSyncDateTime", label: "Last sync" },
];

/** Columns the table renders but the server cannot order by — see ColumnKey for
 *  why each one is here. Named rather than inlined into the filter below so
 *  adding a third is one edit in one place, and so the reason lives with the
 *  list rather than in a `!==` chain. */
const UNSORTABLE_COLUMNS = new Set<string>(["holder", "lastSyncDateTime"]);

/** The Sort control's options — every column EXCEPT the unsortable ones.
 *
 *  This used to be `ITEM_COLUMNS` itself, on the invariant that the table shows
 *  nothing it cannot also sort. That invariant is deliberately broken (see
 *  ColumnKey), so the two lists diverge here rather than offering a sort the
 *  server would silently drop: parseSortKeys accepts neither key, so a
 *  `?sort=holder` URL falls back to the default order with no error. */
export const SORTABLE_COLUMNS: { key: SortField; label: string }[] = ITEM_COLUMNS.filter(
  (c): c is { key: SortField; label: string } => !UNSORTABLE_COLUMNS.has(c.key),
);

const SORT_LABEL = new Map<string, string>(SORTABLE_COLUMNS.map((c) => [c.key, c.label]));

/** The text the "Sort & filter" trigger reads back, so the current sort and unit
 *  filter stay legible with the menu closed.
 *
 *  Takes the primary key, its direction and the unit as plain values rather than
 *  a `SortKey[]`: that type is owned by `listItems` in the `server-only`,
 *  Prisma-importing items.service, and this module deliberately imports nothing.
 *
 *  The SECONDARY key is deliberately absent. It only breaks ties, and appending
 *  it pushes the trigger past its share of a 390px toolbar row — the same
 *  resizing problem that made the Print QR label constant.
 *
 *  An unrecognised key reads as "Newest", matching what the server actually
 *  does with one: parseSortKeys drops a key outside ITEM_SORT_COLUMNS, so the
 *  list comes back in the default order. Claiming a sort that is not applied
 *  would be a confident wrong answer about the property book. */
export function sortFilterSummary(
  sort: string | null,
  dir: SortDir,
  uic: string | null,
  needsRename = false,
): string {
  const label = sort ? SORT_LABEL.get(sort) : undefined;
  const sortPart = label ? `${label} ${dir === "asc" ? "▲" : "▼"}` : "Newest";
  const parts = [sortPart];
  const unit = uic?.trim();
  if (unit) parts.push(unit);
  // Short — "Needs rename" would crowd a 390px trigger that may already be
  // carrying a sort and a unit, and this is the least ambiguous abbreviation
  // of the three. An ACTIVE filter must be visible with the menu shut, for the
  // same reason the sort is: a list silently showing 3 of 1,204 devices is a
  // confident wrong answer about the property book.
  if (needsRename) parts.push("Rename");
  return parts.join(" · ");
}

const SORT_FIELDS = new Set<string>(SORTABLE_COLUMNS.map((c) => c.key));
// Visibility and sortability are separate CONCEPTS on purpose: hiding a column
// must never imply you cannot sort by it. They also now differ in MEMBERSHIP —
// COLUMN_KEYS has 10 keys (including "holder"), SORT_FIELDS has 9 — because
// `holder` is displayable but not server-sortable (see SORTABLE_COLUMNS above).
const COLUMN_KEYS = new Set<string>(ITEM_COLUMNS.map((c) => c.key));

/** Client-side ordering of rows already in hand. The /items table does NOT use
 *  it — sorting there is server-side so it acts over the whole catalogue, not
 *  one page — so note that this orders `readiness` by its raw state string,
 *  which is not the operational sequence listItems sorts by (READINESS_ORDER). */
export function sortItemRows(items: ItemRow[], field: SortField | null, dir: SortDir): ItemRow[] {
  return sortRows(items, field, dir);
}

export function parseSortPref(raw: string | null): SortPref {
  return parseSortPrefGeneric<SortField>(raw, SORT_FIELDS);
}

/** Ids of the rows a user can actually select. Retired items render no
 *  checkbox, so they can never be part of a selection. */
export function selectableIds(items: ItemRow[]): string[] {
  return items.filter((it) => it.status === "ACTIVE").map((it) => it.id);
}

export type SelectAllState = "none" | "some" | "all";

/** Tri-state for the header checkbox, derived from the selectable rows only.
 *  A list with nothing selectable is always "none" — never "all" — so the
 *  header box cannot claim a selection that no row could hold. */
export function selectAllState(items: ItemRow[], selected: ReadonlySet<string>): SelectAllState {
  const ids = selectableIds(items);
  if (ids.length === 0) return "none";
  const hits = ids.filter((id) => selected.has(id)).length;
  if (hits === 0) return "none";
  return hits === ids.length ? "all" : "some";
}

/* ── Text width estimation, for the card More panel's one-line Home unit ──────
 *
 * Widths in em for Geist (this app's `--font-sans`), MEASURED in a browser at
 * font-size 100px rather than guessed. Only the glyphs that actually appear in
 * unit names are listed; anything else falls back to a per-class default below.
 *
 * Why a table at all: the row used to be sized from the character COUNT times
 * one flat ceiling, which charges "DET 3, COMPANY C 2D BATTALION 641ST AVIATION
 * REGIMENT" — nine spaces and a comma, all about a quarter em — as if every
 * character were a capital. That over-estimate is what pushed the font onto its
 * floor and made the value wrap on a narrow phone, i.e. it defeated the very
 * thing the sizing exists for. A comma is 0.20em and a W is 0.95em; treating
 * them alike wastes up to 17% of the line.
 */
const GLYPH_EM: Record<string, number> = {
  " ": 0.25, ",": 0.20, ".": 0.25, "'": 0.20, "(": 0.27, ")": 0.27,
  "-": 0.42, "/": 0.45, "&": 0.62, "#": 0.48, ":": 0.27, ";": 0.27,
  A: 0.67, B: 0.68, C: 0.70, D: 0.69, E: 0.60, F: 0.59, G: 0.70, H: 0.71,
  I: 0.27, J: 0.60, K: 0.70, L: 0.58, M: 0.88, N: 0.74, O: 0.74, P: 0.65,
  Q: 0.73, R: 0.67, S: 0.64, T: 0.55, U: 0.69, V: 0.67, W: 0.95, X: 0.67,
  Y: 0.58, Z: 0.62,
  "0": 0.66, "1": 0.38, "2": 0.62, "3": 0.61, "4": 0.62, "5": 0.62,
  "6": 0.59, "7": 0.52, "8": 0.63, "9": 0.59,
  // Unit names are nearly all uppercase, but not entirely ("Environmental"),
  // and the class fallback over-estimated that one by a third — a smaller font
  // than it needed, on a value with room to spare.
  a: 0.55, c: 0.55, e: 0.56, f: 0.40, i: 0.24, l: 0.27, m: 0.88, n: 0.58,
  o: 0.57, r: 0.38, t: 0.39, v: 0.54, y: 0.54,
};

/** Unlisted glyphs, by class. Deliberately on the HIGH side of what Geist
 *  actually draws: over-estimating costs a fraction of a pixel of font size,
 *  while under-estimating overflows the line the whole mechanism exists to
 *  keep to one. */
function fallbackEm(ch: string): number {
  if (ch >= "A" && ch <= "Z") return 0.75;
  if (ch >= "0" && ch <= "9") return 0.66;
  if (ch >= "a" && ch <= "z") return 0.62;
  return 0.60;
}

/** Safety margin on the estimate. Covers rounding in the table, the fallbacks,
 *  and the case that matters most: the webfont failing to load, so the text is
 *  drawn in `system-ui` with metrics this table never saw. */
const WIDTH_SAFETY = 1.02;

/** Estimated rendered width of `text`, in em.
 *
 *  Pure and synchronous on purpose — it runs during render for every row on the
 *  page, and the panel it sizes lives inside a CLOSED `<details>`, so there is
 *  no layout to measure even if measuring were affordable. CSS divides the
 *  column width by this number to get a font size (see `.card-more__fit`). */
export function estimateTextEm(text: string): number {
  let em = 0;
  for (const ch of text) em += GLYPH_EM[ch] ?? fallbackEm(ch);
  return Math.round(em * WIDTH_SAFETY * 100) / 100;
}

/** A displayable value, or null when there is nothing to show.
 *
 *  ONE definition of "missing" for the card's More panel, because this data is
 *  messy in three different ways at once: the CSV importer copies MDM columns
 *  verbatim, so the same absent fact arrives as `null` from one export, `""`
 *  from another and `"   "` from a third. Testing them separately is how a
 *  panel ends up with a labelled blank row that reads like a rendering bug —
 *  and it is why the whitespace case is trimmed away rather than rendered.
 *
 *  Returns the TRIMMED string, so callers render exactly what they measured:
 *  the Home unit row sizes its font by this string's length. */
export function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseHiddenCols(raw: string | null): ColumnKey[] {
  return parseHiddenColsGeneric<ColumnKey>(raw, COLUMN_KEYS, ITEM_COLUMNS.length);
}
