export type NavItem = { label: string; href: string };

export function navItemsFor({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const search: NavItem = { label: "Search", href: "/" };
  if (!loggedIn) return [search, { label: "Staff sign in", href: "/login" }];
  const items: NavItem[] = [search, { label: "Items", href: "/items" }];
  if (isAdmin) {
    items.push(
      { label: "Dashboard", href: "/admin" },
      { label: "New item", href: "/admin/items/new" },
      { label: "Queue", href: "/admin/queue" },
      { label: "Users", href: "/admin/users" },
      { label: "Audit", href: "/admin/audit" },
    );
  }
  items.push({ label: "Account", href: "/account" });
  return items;
}

// Home ("/") and the admin dashboard ("/admin") match only exactly; every other
// item matches its subtree. "/admin" needs the exact-match rule because it is a
// prefix of the other admin routes (/admin/queue, /admin/users, …) — subtree
// matching would light the Dashboard link up on every admin page.
export function isActive(href: string, pathname: string): boolean {
  if (href === "/" || href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}
