export type NavItem = { label: string; href: string };

export function navItemsFor({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const search: NavItem = { label: "Search", href: "/" };
  if (!loggedIn) return [search, { label: "Staff sign in", href: "/login" }];
  const items: NavItem[] = [search, { label: "Items", href: "/items" }];
  if (isAdmin) {
    items.push(
      { label: "New item", href: "/admin/items/new" },
      { label: "Users", href: "/admin/users" },
      { label: "Audit", href: "/admin/audit" },
    );
  }
  items.push({ label: "Account", href: "/account" });
  return items;
}

// Home ("/") matches only exactly; every other item matches its subtree.
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
