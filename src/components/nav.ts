// The icon is a plain string KEY, not a component: this module is pure and
// unit-tested (nav.test.ts), and importing lucide-react here would drag a React
// dependency into it. AppHeader maps the key to the actual icon — one nav
// definition, resolved at the only place that renders it.
export type NavIcon = "search" | "items" | "queue" | "users" | "dashboard" | "signin";

export type NavItem = { label: string; href: string; icon: NavIcon };

/**
 * The nav destinations for a role.
 *
 * ACCOUNT IS DELIBERATELY ABSENT. It is reached from the profile icon in the
 * header's top-right corner (see AppHeader), not from this list — so it is in
 * the same place at every width and never spends a rail tab. Anything added
 * here becomes both a header link AND a bottom-rail tab, so keep it to
 * destinations that earn a permanent slot; at 375px five tabs is the practical
 * ceiling before labels start truncating.
 *
 * Queue and Users are back as top-level entries. They were folded into the
 * Dashboard hub in 4dc1fe5 (2026-07-21) "so the header stays short" — a
 * constraint that applied to a single-row header, not to a bottom rail, and the
 * two of them are the admin pages reached most often.
 */
export function navItemsFor({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const search: NavItem = { label: "Search", href: "/", icon: "search" };
  if (!loggedIn) return [search, { label: "Staff sign in", href: "/login", icon: "signin" }];
  const items: NavItem[] = [search, { label: "Items", href: "/items", icon: "items" }];
  if (isAdmin) {
    items.push(
      { label: "Queue", href: "/admin/queue", icon: "queue" },
      { label: "Users", href: "/admin/users", icon: "users" },
      // Still the hub for everything without its own tab — Analytics,
      // Categories, Units, Audit, New item. See admin/page.tsx.
      { label: "Dashboard", href: "/admin", icon: "dashboard" },
    );
  }
  return items;
}

// Home ("/") matches only exactly; every other item matches its subtree, so
// "/admin" matches "/admin/queue" too. That overlap is intentional and is
// resolved by activeHref below, NOT by narrowing this predicate — callers that
// ask "is this href on the current path" still want the subtree answer.
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * The ONE item to mark as current, by longest matching href.
 *
 * Necessary because Queue and Users live under the Dashboard's subtree: on
 * /admin/queue, `isActive` is true for BOTH "/admin/queue" and "/admin", so
 * marking every match would light up two tabs and put `aria-current="page"` on
 * two links — which is wrong for a screen reader, not just untidy. Most
 * specific wins, so /admin/queue picks Queue while /admin/audit (no tab of its
 * own) still falls back to Dashboard.
 *
 * Returns null when nothing matches — /account is the live example, since it
 * has no nav item; the profile icon carries the current marker there instead.
 */
export function activeHref(items: NavItem[], pathname: string): string | null {
  let best: string | null = null;
  for (const it of items) {
    if (!isActive(it.href, pathname)) continue;
    if (best === null || it.href.length > best.length) best = it.href;
  }
  return best;
}
