import { useSyncExternalStore } from "react";

/** A tiny localStorage-backed store, created at module scope so its mutable
 *  cache lives outside React's render cycle. Read via useSyncExternalStore so
 *  the server snapshot (default) is used during SSR/hydration and the persisted
 *  value takes over on the client — no hydration mismatch, no setState-in-effect.
 *  Also syncs across tabs via the `storage` event. */
export function makeStore<T>(key: string, parse: (raw: string | null) => T) {
  const listeners = new Set<() => void>();
  let cacheRaw: string | null | undefined;
  let cacheVal: T;
  return {
    get(): T {
      let raw: string | null = null;
      try { raw = window.localStorage.getItem(key); } catch { /* unavailable */ }
      if (cacheRaw !== raw) { cacheRaw = raw; cacheVal = parse(raw); }
      return cacheVal;
    },
    set(value: T) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
      cacheRaw = undefined;
      listeners.forEach((l) => l());
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => { if (e.key === key) { cacheRaw = undefined; cb(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
  };
}

export function usePersistedPref<T>(
  store: { get: () => T; set: (v: T) => void; subscribe: (cb: () => void) => () => void },
  serverDefault: T,
): [T, (value: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, () => serverDefault);
  return [value, store.set];
}
