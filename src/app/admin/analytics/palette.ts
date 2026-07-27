/* ============================================================
   Chart palette.

   These values are NOT eyeballed. Every set below was run through the
   data-viz validator against THIS app's ledger surface (#fbfcf9) — the
   surface matters, because contrast is measured against it:

     categorical (8 slots)  -> ALL CHECKS PASS
                               worst adjacent CVD ΔE 9.1 (target >= 8)
                               worst adjacent normal-vision ΔE 19.6 (floor 15)
                               WARN: aqua/yellow/magenta sit under 3:1 on this
                               surface, so the "relief rule" applies — every
                               chart ships a legend AND a "View as table" mode.
                               Do not drop the table view; it is the mitigation.

     accountability pair    -> blue + critical-red, ALL CHECKS PASS
                               (CVD ΔE 23.8, normal-vision 31.6)

   IMPORTANT — the obvious green/red pair for "accounted for vs not" was
   tried first and FAILED: #0ca30c vs #d03b3b measures CVD ΔE 4.1 under
   deuteranopia, i.e. indistinguishable to red-green colourblind viewers.
   Blue-vs-red carries the same "good vs problem" reading and passes. Do
   not "fix" the donut back to green.

   If you change any hex here, re-run the validator before committing:
     node scripts/validate_palette.js "<hex,hex,...>" --mode light --surface "#fbfcf9"
   ============================================================ */

import type { StatusKey } from "./analytics.types";

/** Categorical slots, in fixed order. Assign by slot, NEVER cycle, and never
 *  reassign on filter — colour follows the entity, not its rank. */
export const SERIES = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
] as const;

/** Beyond 8 series the palette is not extended with generated hues — the
 *  overflow folds into one "Other" series (see foldCategories). */
export const MAX_SERIES = SERIES.length;
export const OTHER_CATEGORY = "Other";
export const OTHER_COLOR = "#8a9487"; // ledger --text-subtle, deliberately recessive

/** Readiness states get fixed slots so a status keeps its colour no matter
 *  which other states happen to be present. Stack order matches slot order,
 *  which is the order the adjacent-pair CVD check was run against. */
export const STATUS_COLOR: Record<StatusKey, string> = {
  DEPLOYED: SERIES[0],
  READY_TO_DEPLOY: SERIES[1],
  IN_REPAIR: SERIES[2],
  RETIRED: SERIES[3],
  UNTRIAGED: SERIES[4],
};

/** Two-slice accountability donut. See the FAILED green/red note above. */
export const ACCOUNTED_COLOR = "#2a78d6";
export const NOT_ACCOUNTED_COLOR = "#d03b3b";

/** Chart chrome, taken from the ledger design system so plots sit on the
 *  paper rather than on a foreign white card. */
export const CHROME = {
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  muted: "#8a9487",
  ink: "#191c18",
  surface: "#fbfcf9",
} as const;

export const colorForIndex = (i: number) => SERIES[i % SERIES.length];

/**
 * Stable colour for a category, independent of what is on screen.
 *
 * `vocabulary` is the full ordered category list (every category that exists,
 * not just the ones in the current result). Keying off position in THAT list
 * means selecting a UIC — which changes how many categories have data —
 * cannot repaint the survivors. Keying off the rendered array instead, as this
 * originally did, shifted every colour whenever the filter changed, breaking
 * the rule at the top of this file: colour follows the entity, never its rank.
 *
 * A category absent from the vocabulary (e.g. "Uncategorized", or a value only
 * present on items) falls to the end deterministically rather than colliding
 * with slot 0.
 */
export function makeCategoryColor(vocabulary: string[]): (category: string) => string {
  const slot = new Map<string, number>();
  vocabulary.forEach((name, i) => slot.set(name.toLowerCase(), i));
  return (category: string) => {
    if (category === OTHER_CATEGORY) return OTHER_COLOR;
    const i = slot.get(category.toLowerCase());
    if (i !== undefined) return colorForIndex(i);
    // Deterministic fallback: hash the name so it is at least stable across
    // renders and filters, even though it is outside the curated list.
    let h = 0;
    for (let k = 0; k < category.length; k++) h = (h * 31 + category.charCodeAt(k)) >>> 0;
    return colorForIndex(vocabulary.length + (h % SERIES.length));
  };
}

/**
 * Cap a category list at MAX_SERIES, folding the tail into "Other".
 * Returns the kept names in order plus the folded set, so the caller can
 * re-bucket its data points consistently.
 */
export function foldCategories(categories: string[]): {
  kept: string[];
  folded: Set<string>;
  /** The label used for the overflow bucket, or null when nothing folded.
   *  Returned rather than assumed so the caller keys its data rows by the
   *  same string this function put in `kept` — they must not drift. */
  overflowLabel: string | null;
} {
  if (categories.length <= MAX_SERIES) {
    return { kept: categories, folded: new Set(), overflowLabel: null };
  }
  const kept = categories.slice(0, MAX_SERIES - 1);
  const folded = new Set(categories.slice(MAX_SERIES - 1));
  // A real category literally named "Other" would otherwise have its counts
  // silently merged into the overflow bucket. Keep the label distinct.
  const overflowLabel = kept.includes(OTHER_CATEGORY) ? `${OTHER_CATEGORY} categories` : OTHER_CATEGORY;
  return { kept: [...kept, overflowLabel], folded, overflowLabel };
}
