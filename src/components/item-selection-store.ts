import { makeStore } from "./persisted-pref";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
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
    // Capped at the same MAX_BULK_ITEMS every writer and every bulk action
    // enforces. Nothing in the app can store more than 500, so a longer array
    // is either a hand-edited key or a forged one — and without this the client
    // would happily render and post a batch the server refuses outright,
    // telling the operator "too many items" about a selection they never made.
    const items = v.items.filter(isSelectedItem).slice(0, MAX_BULK_ITEMS);
    const startedAt =
      typeof v.startedAt === "number" && Number.isFinite(v.startedAt) ? v.startedAt : 0;
    return { startedAt, items };
  } catch {
    return EMPTY_SELECTION;
  }
}

export const selectionStore = makeStore<PersistedSelection>(SELECTION_KEY, parseSelection);
