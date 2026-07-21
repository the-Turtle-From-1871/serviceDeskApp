export type NavItem = { label: string; href: string };

export function navItemsFor({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const search: NavItem = { label: "Search", href: "/" };
  if (!loggedIn) return [search, { label: "Staff sign in", href: "/login" }];
  const items: NavItem[] = [search, { label: "Items", href: "/items" }];
  if (isAdmin) {
    // The admin sub-sections (Queue, Users, Audit) and the New-item action live
    // UNDER the Dashboard hub (/admin) rather than as separate header links, so
    // the header stays short. See the "Manage" section in admin/page.tsx.
    items.push({ label: "Dashboard", href: "/admin" });
  }
  items.push({ label: "Account", href: "/account" });
  return items;
}

// Home ("/") matches only exactly; every other item matches its subtree. The
// admin Dashboard ("/admin") is now the hub for the whole admin area, so it
// SUBTREE-matches: it stays highlighted on /admin/queue, /admin/users, etc.
// (Previously it matched exactly, to avoid competing with the separate admin
// sub-links that used to sit alongside it in the header; those have moved into
// the Dashboard page, so there is nothing left to compete with.)
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}
