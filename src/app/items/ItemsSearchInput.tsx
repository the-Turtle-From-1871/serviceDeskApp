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
  // Ignore an out-of-order debounce firing after a newer keystroke already
  // scheduled its own (mirrors HomeSearch's reqId guard).
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    const timer = setTimeout(() => {
      if (id !== reqId.current) return; // superseded by a later keystroke
      const params = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) params.set("q", trimmed);
      if (sort) {
        params.set("sort", sort);
        params.set("dir", dir);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort/dir/router are stable per render cycle; only `query` should re-trigger the debounce
  }, [query]);

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
