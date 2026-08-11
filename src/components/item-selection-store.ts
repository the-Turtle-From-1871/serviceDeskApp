import { makeStore } from "./persisted-pref";
import type { SelectedItem } from "./items-view";

/** Versioned, so a future shape change retires old batches instead of parsing
 *  them into something subtly wrong. */
export const SELECTION_KEY = "items:selection:v1";

/** What is persisted: the selected items, plus when the batch began — the bar
 *  renders the age so a batch found the next morning is legible rather than
 *  mysterious. */
export type PersistedSelection = { startedAt: number; items: SelectedItem[] };

export const EMPTY_SELECTION: PersistedSelection = { startedAt: 0, items: [] };

/** localStorage is attacker-writable and survives deploys, so every field is
 *  validated rather than trusted. A bad entry is DROPPED, not defaulted: a
 *  half-parsed item would render a row with a blank serial and, worse, could
 *  reach a bulk action as an id nobody scanned. */
function isSelectedItem(v: unknown): v is SelectedItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" && o.id !== "" &&
    typeof o.make === "string" &&
    typeof o.model === "string" &&
    typeof o.serialNumber === "string" &&
    (o.status === "ACTIVE" || o.status === "RETIRED")
  );
}

export function parseSelection(raw: string | null): PersistedSelection {
  if (!raw) return EMPTY_SELECTION;
  try {
    const v = JSON.parse(raw) as { startedAt?: unknown; items?: unknown };
    if (!Array.isArray(v.items)) return EMPTY_SELECTION;
    const items = v.items.filter(isSelectedItem);
    const startedAt =
      typeof v.startedAt === "number" && Number.isFinite(v.startedAt) ? v.startedAt : 0;
    return { startedAt, items };
  } catch {
    return EMPTY_SELECTION;
  }
}

export const selectionStore = makeStore<PersistedSelection>(SELECTION_KEY, parseSelection);
