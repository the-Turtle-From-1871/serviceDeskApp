export type SortDir = "asc" | "desc";
export type SortPref<F extends string> = { field: F | null; dir: SortDir };

const DEFAULT_SORT = { field: null, dir: "asc" as SortDir };

/** Case-insensitive sort of rows by a string-valued field. Null/blank values
 *  sort last in both directions. Returns a new array; input is not mutated. */
export function sortRows<T, F extends Extract<keyof T, string>>(rows: T[], field: F | null, dir: SortDir): T[] {
  const copy = rows.slice();
  if (!field) return copy;
  copy.sort((a, b) => {
    const av = a[field] as unknown;
    const bv = b[field] as unknown;
    const aBlank = av == null || av === "";
    const bBlank = bv == null || bv === "";
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    const base = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return dir === "asc" ? base : -base;
  });
  return copy;
}

/** Parse a persisted sort pref, validating `field` against `validFields` and
 *  requiring a real direction. Falls back to { field: null, dir: "asc" }. */
export function parseSortPref<F extends string>(raw: string | null, validFields: ReadonlySet<string>): SortPref<F> {
  if (!raw) return { ...DEFAULT_SORT };
  try {
    const v = JSON.parse(raw) as { field?: unknown; dir?: unknown };
    const field = typeof v.field === "string" && validFields.has(v.field) ? (v.field as F) : null;
    const dir = v.dir === "desc" ? "desc" : v.dir === "asc" ? "asc" : null;
    if (!dir) return { ...DEFAULT_SORT };
    return { field, dir };
  } catch {
    return { ...DEFAULT_SORT };
  }
}

/** Parse persisted hidden-column keys. Never returns a set that hides every
 *  column (that would leave a column-less table). */
export function parseHiddenCols<F extends string>(raw: string | null, validFields: ReadonlySet<string>, columnCount: number): F[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const cols = v.filter((k): k is F => typeof k === "string" && validFields.has(k));
    if (cols.length >= columnCount) return [];
    return cols;
  } catch {
    return [];
  }
}
