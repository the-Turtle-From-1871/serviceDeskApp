"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Live, debounced search for /items — mirrors HomeSearch.tsx's debounce
// pattern, but navigates the URL (via router.replace) instead of calling a
// server action directly. /items must stay server-side paginated (the Items
// table is 1,200+ rows), so the query has to travel through the URL into the
// Server Component's `listItems({ search, sort, dir, page })` call rather
// than filtering anything client-side.
export function ItemsSearchInput({
  q,
  sort,
  dir,
}: {
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
}) {
  const router = useRouter();
  const [query, setQuery] = useState(q);
  const [isPending, startTransition] = useTransition();
  // Read the latest sort/dir via refs (synced every render, via an effect —
  // mutating a ref directly during render is disallowed) so the debounce
  // timer never fires with a stale closure if sort/dir change while a
  // keystroke's timer is still pending.
  const sortRef = useRef(sort);
  const dirRef = useRef(dir);
  useEffect(() => {
    sortRef.current = sort;
    dirRef.current = dir;
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
      if (sortRef.current) {
        params.set("sort", sortRef.current);
        params.set("dir", dirRef.current);
      }
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
        placeholder="Search device name, make, model, or serial number"
        style={{ maxWidth: 360 }}
      />
      <span aria-live="polite" role="status" className="subtle">
        {isPending ? "Searching…" : ""}
      </span>
    </form>
  );
}
