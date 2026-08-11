"use client";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { SelectedItem } from "./items-view";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { usePersistedPref } from "./persisted-pref";
import { selectionStore, EMPTY_SELECTION } from "./item-selection-store";

export type { SelectedItem };

type ItemSelectionValue = {
  /** id -> item. A Map, not a Set of ids, so it survives paging: the
   *  receipt-group validation needs each selected item's make/model, and an
   *  item selected on page 1 is gone from `items` once you page forward. */
  selected: ReadonlyMap<string, SelectedItem>;
  /** Epoch ms the current batch began, or 0 when nothing is selected. */
  startedAt: number;
  /** True once the selection has reached MAX_BULK_ITEMS — further scans are
   *  refused rather than collected and failed at the end. */
  atCap: boolean;
  toggle: (item: SelectedItem) => void;
  addMany: (items: SelectedItem[]) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
};

const Ctx = createContext<ItemSelectionValue | null>(null);

/**
 * Owns the /items selection. It lives here rather than inside ItemSelectTable
 * because the scan sheet and the table are SIBLING client components under a
 * Server Component page, so neither can reach the other's state.
 *
 * PERSISTED to localStorage: a scanned batch can be 150 devices collected over
 * twenty minutes walking a room, and losing it to a screen lock or an
 * accidental back-swipe means re-scanning from zero with no record of what was
 * already counted. usePersistedPref is built on useSyncExternalStore, so the
 * server snapshot is used during SSR and the stored value takes over on the
 * client — no hydration mismatch, and it syncs across tabs for free.
 */
export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [persisted] = usePersistedPref(selectionStore, EMPTY_SELECTION);

  const selected = useMemo(
    () => new Map(persisted.items.map((it) => [it.id, it])),
    [persisted.items],
  );

  /**
   * Every mutation reads the CURRENT stored value rather than closing over
   * `persisted`. ItemsScanButton calls addMany from a decode loop that fires
   * again before React has re-rendered, so a closed-over snapshot would drop
   * scans — the same hazard its own `seen` ref exists to avoid. store.get()
   * re-reads localStorage, so this is always the live list.
   */
  const mutate = useCallback((fn: (items: SelectedItem[]) => SelectedItem[]) => {
    const current = selectionStore.get();
    const items = fn(current.items);
    selectionStore.set(
      items.length === 0
        ? EMPTY_SELECTION
        : { startedAt: current.startedAt || Date.now(), items },
    );
  }, []);

  const toggle = useCallback((item: SelectedItem) => {
    mutate((items) =>
      items.some((i) => i.id === item.id)
        ? items.filter((i) => i.id !== item.id)
        : items.length >= MAX_BULK_ITEMS
          ? items
          : [...items, item],
    );
  }, [mutate]);

  // RETIRED is refused HERE as well as by callers: retired rows render no
  // checkbox and selectableIds excludes them, so a bulk action must never
  // receive one. `toggle` stays permissive on purpose — it is the checkbox's
  // own handler, and a strict toggle could not un-select a row that somehow
  // got in.
  const addMany = useCallback((incoming: SelectedItem[]) => {
    mutate((items) => {
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const it of incoming) {
        if (it.status !== "ACTIVE") continue;
        if (!byId.has(it.id) && byId.size >= MAX_BULK_ITEMS) continue;
        byId.set(it.id, it);
      }
      return [...byId.values()];
    });
  }, [mutate]);

  const removeMany = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    mutate((items) => items.filter((i) => !drop.has(i.id)));
  }, [mutate]);

  const clear = useCallback(() => selectionStore.set(EMPTY_SELECTION), []);

  const value = useMemo(
    () => ({
      selected,
      startedAt: persisted.startedAt,
      atCap: selected.size >= MAX_BULK_ITEMS,
      toggle,
      addMany,
      removeMany,
      clear,
    }),
    [selected, persisted.startedAt, toggle, addMany, removeMany, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useItemSelection(): ItemSelectionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useItemSelection must be used inside <ItemSelectionProvider>");
  return ctx;
}
