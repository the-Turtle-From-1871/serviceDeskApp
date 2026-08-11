"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SelectedItem } from "./items-view";

export type { SelectedItem };

type ItemSelectionValue = {
  /** id -> item. A Map, not a Set of ids, so it survives paging: the
   *  receipt-group validation needs each selected item's make/model, and an
   *  item selected on page 1 is gone from `items` once you page forward. */
  selected: ReadonlyMap<string, SelectedItem>;
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
 */
export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());

  const toggle = useCallback((item: SelectedItem) => {
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(item.id)) n.delete(item.id);
      else n.set(item.id, item);
      return n;
    });
  }, []);

  // RETIRED is refused HERE as well as by callers: retired rows render no
  // checkbox and selectableIds excludes them, so a bulk action must never
  // receive one. `toggle` stays permissive on purpose — it is the checkbox's
  // own handler, and a strict toggle could not un-select a row that somehow
  // got in.
  const addMany = useCallback((items: SelectedItem[]) => {
    setSelected((prev) => {
      const n = new Map(prev);
      for (const it of items) if (it.status === "ACTIVE") n.set(it.id, it);
      return n;
    });
  }, []);

  const removeMany = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const n = new Map(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Map()), []);

  const value = useMemo(
    () => ({ selected, toggle, addMany, removeMany, clear }),
    [selected, toggle, addMany, removeMany, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useItemSelection(): ItemSelectionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useItemSelection must be used inside <ItemSelectionProvider>");
  return ctx;
}
