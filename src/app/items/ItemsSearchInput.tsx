"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SortKey } from "@/components/ItemSelectTable";

// Live, debounced search for /items — mirrors HomeSearch.tsx's debounce
// pattern, but navigates the URL (via router.replace) instead of calling a
// server action directly. /items must stay server-side paginated (the Items
// table is 1,200+ rows), so the query has to travel through the URL into the
// Server Component's `listItems({ search, sort, dir, page })` call rather
// than filtering anything client-side.
export function ItemsSearchInput({
  q,
  sortKeys,
  uic,
  needsRename,
  loaner,
}: {
  q: string;
  /** The FULL compound sort, not just the first key — rebuilding the URL from
   *  a lone `sort`/`dir` silently collapsed a two-key sort down to one. */
  sortKeys: SortKey[];
  uic: string | null;
  needsRename: boolean;
  loaner: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(q);
  const [isPending, startTransition] = useTransition();
  // This component REBUILDS the /items URL from scratch, so it must carry every
  // piece of state that lives there. Anything missing here is silently dropped
  // the moment someone types in the search box — that is how the UIC filter and
  // the secondary sort key both used to disappear.
  //
  // Read the latest values via refs (synced every render, via an effect —
  // mutating a ref directly during render is disallowed) so the debounce timer
  // never fires with a stale closure if they change while a keystroke's timer
  // is still pending.
  const sortRef = useRef(sortKeys);
  const uicRef = useRef(uic);
  const needsRenameRef = useRef(needsRename);
  const loanerRef = useRef(loaner);
  useEffect(() => {
    sortRef.current = sortKeys;
    uicRef.current = uic;
    needsRenameRef.current = needsRename;
    loanerRef.current = loaner;
  });

  useEffect(() => {
    // If the URL already reflects this query (e.g. on mount, or any other
    // render where `query` didn't actually change relative to the URL),
    // there's nothing to navigate — bail before scheduling anything. This is
    // what stops a mount-time fire from dropping `page` off a deep link like
    // /items?page=2.
    if (query.trim() === q.trim()) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) params.set("q", trimmed);
      if (sortRef.current.length > 0) {
        params.set("sort", sortRef.current.map((k) => k.key).join(","));
        params.set("dir", sortRef.current.map((k) => k.dir).join(","));
      }
      if (uicRef.current) params.set("uic", uicRef.current);
      if (needsRenameRef.current) params.set("needsRename", "1");
      if (loanerRef.current) params.set("loaner", "1");
      // Changing the query resets to page 1 (omitted = page 1): a narrower
      // result set could otherwise strand the user on a now-empty page.
      const s = params.toString();
      const href = s ? `/items?${s}` : "/items";
      startTransition(() => {
        router.replace(href, { scroll: false });
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, q, router]);

  return (
    <form className="row" style={{ gap: 8 }} onSubmit={(e) => e.preventDefault()}>
      <input
        className="input"
        name="q"
        aria-label="Search items"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search device name, make, model, serial number, or recipient"
        style={{ maxWidth: 360 }}
      />
      <span aria-live="polite" role="status" className="subtle">
        {isPending ? "Searching…" : ""}
      </span>
    </form>
  );
}
